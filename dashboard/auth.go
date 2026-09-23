package main

// Authentication for the dashboard.
//
// The dashboard publishes the whole cluster's shape - every node, pod,
// namespace, PVC and the project's running spend - on a public hostname
// (dashboard.<domain>, see templates/dashboard.yaml.js). Before this file it
// was served to anyone who guessed that name. Everything here exists to make
// that impossible, and to fail closed rather than open when it is
// misconfigured.
//
// Threat model this is written against: an unauthenticated attacker on the
// internet who can reach the login page, plus a malicious third-party site
// trying to ride a logged-in operator's browser (CSRF / cross-site WebSocket
// hijacking). It is NOT a multi-user system - there is exactly one operator
// credential, provisioned by `flarops init`.

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"html/template"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed login.html logout.html
var authPages embed.FS

var authTemplates = template.Must(template.ParseFS(authPages, "login.html", "logout.html"))

const (
	sessionCookieSecure   = "__Host-flarops_session"
	csrfCookieSecure      = "__Host-flarops_csrf"
	sessionCookieInsecure = "flarops_session"
	csrfCookieInsecure    = "flarops_csrf"

	// PBKDF2-HMAC-SHA256 at OWASP's recommended iteration count. Chosen over
	// Argon2id specifically to avoid pulling golang.org/x/crypto into a
	// generated project: that module now requires a newer Go toolchain than
	// the dashboard's own Dockerfile pins, so depending on it would force a
	// toolchain bump on every project Flarops generates. The password this
	// protects is machine-generated with ~144 bits of entropy, which is far
	// out of reach of any offline attack at this cost; the KDF is here for
	// the case where an operator later replaces it with one of their own.
	pbkdf2Iterations = 600000
	pbkdf2KeyLen     = 32
	pbkdf2SaltLen    = 16

	maxLoginBodyBytes = 4 << 10

	// How stale a session's recorded activity may get before it is written
	// back. See sessionIsValid.
	sessionActivityWriteInterval = time.Minute
)

type authConfig struct {
	username      string
	hash          *passwordHash
	sessionTTL    time.Duration
	idleTTL       time.Duration
	trustProxy    bool
	secureCookies bool
	csrfKey       []byte
}

var auth *authConfig

func (c *authConfig) sessionCookieName() string {
	if c.secureCookies {
		return sessionCookieSecure
	}
	return sessionCookieInsecure
}

func (c *authConfig) csrfCookieName() string {
	if c.secureCookies {
		return csrfCookieSecure
	}
	return csrfCookieInsecure
}

// ---------------------------------------------------------------- password

type passwordHash struct {
	iterations int
	salt       []byte
	key        []byte
}

// PBKDF2-HMAC-SHA256 (RFC 8018 section 5.2) over the standard library's HMAC.
// Implemented here rather than imported so the dashboard keeps building with
// nothing but the Go standard library plus the dependencies it already had.
func pbkdf2Key(password, salt []byte, iterations, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	hashLen := prf.Size()
	numBlocks := (keyLen + hashLen - 1) / hashLen

	var counter [4]byte
	dk := make([]byte, 0, numBlocks*hashLen)
	u := make([]byte, 0, hashLen)

	for block := 1; block <= numBlocks; block++ {
		prf.Reset()
		prf.Write(salt)
		counter[0] = byte(block >> 24)
		counter[1] = byte(block >> 16)
		counter[2] = byte(block >> 8)
		counter[3] = byte(block)
		prf.Write(counter[:])
		dk = prf.Sum(dk)

		t := dk[len(dk)-hashLen:]
		u = append(u[:0], t...)

		for n := 2; n <= iterations; n++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for i := range u {
				t[i] ^= u[i]
			}
		}
	}
	return dk[:keyLen]
}

// Encoded form: pbkdf2-sha256$i=600000$<b64 salt>$<b64 key>
// Only the hash ever leaves the machine that ran `flarops init` - it travels
// as a GitHub secret into a Kubernetes Secret and finally this process's
// environment. Whoever reads any of those still has to break PBKDF2 to get a
// usable password.
func parsePasswordHash(encoded string) (*passwordHash, error) {
	parts := strings.Split(strings.TrimSpace(encoded), "$")
	if len(parts) != 4 {
		return nil, errors.New("expected 4 $-separated fields")
	}
	if parts[0] != "pbkdf2-sha256" {
		return nil, fmt.Errorf("unsupported algorithm %q (want pbkdf2-sha256)", parts[0])
	}

	name, value, ok := strings.Cut(parts[1], "=")
	if !ok || name != "i" {
		return nil, fmt.Errorf("malformed iteration parameter %q", parts[1])
	}
	iterations, err := strconv.Atoi(value)
	if err != nil || iterations < 1 {
		return nil, fmt.Errorf("malformed iteration count %q", value)
	}
	// An attacker who could rewrite the environment could otherwise set i=1
	// and turn the stored hash into a trivially crackable one.
	if iterations < 100000 {
		return nil, fmt.Errorf("iteration count %d is below the 100000 minimum", iterations)
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, fmt.Errorf("salt is not valid base64: %w", err)
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return nil, fmt.Errorf("hash is not valid base64: %w", err)
	}
	if len(salt) < 8 || len(key) < 16 {
		return nil, errors.New("salt or hash is too short")
	}

	return &passwordHash{iterations: iterations, salt: salt, key: key}, nil
}

// Each verification is deliberately expensive, so running them one at a time
// keeps a burst of login attempts from monopolising the container's CPU.
//
// Serialising alone was not enough to bound that cost. The failure counters
// below are incremented only AFTER a verification finishes, so a burst of
// concurrent requests all read a counter of zero, all pass the rate check,
// and all queue up here - the limiter capped the number of ANSWERED attempts,
// never the number of queued ones, and the queue had no bound at all. Waiters
// are counted, and anything arriving past the cap is turned away without
// running the KDF, which is what actually bounds the work a single burst can
// buy.
const maxQueuedVerifications = 4

var (
	verifyGate    = make(chan struct{}, 1)
	verifyWaiting atomic.Int32
)

// ErrVerifierBusy is returned rather than a plain "wrong password": the
// credential was never examined, so reporting it as a failure would let an
// attacker lock the operator out by keeping the queue full.
var errVerifierBusy = errors.New("password verifier is saturated")

func (h *passwordHash) verify(password string) (bool, error) {
	if verifyWaiting.Add(1) > maxQueuedVerifications {
		verifyWaiting.Add(-1)
		return false, errVerifierBusy
	}
	defer verifyWaiting.Add(-1)

	verifyGate <- struct{}{}
	defer func() { <-verifyGate }()

	candidate := pbkdf2Key([]byte(password), h.salt, h.iterations, len(h.key))
	return subtle.ConstantTimeCompare(candidate, h.key) == 1, nil
}

// ------------------------------------------------------------------ config

func durationFromEnv(name string, fallback time.Duration) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		log.Printf("auth: ignoring invalid %s=%q, using %s", name, raw, fallback)
		return fallback
	}
	return d
}

// A missing or unparseable credential is fatal, never a reason to serve the
// dashboard unauthenticated: the whole point of this file is that there is no
// configuration mistake that quietly puts the cluster's internals back on the
// public internet.
func loadAuthConfig() (*authConfig, error) {
	encoded := os.Getenv("DASHBOARD_PASSWORD_HASH")
	if strings.TrimSpace(encoded) == "" {
		return nil, errors.New("DASHBOARD_PASSWORD_HASH is not set - refusing to start an unauthenticated dashboard")
	}
	hash, err := parsePasswordHash(encoded)
	if err != nil {
		return nil, fmt.Errorf("DASHBOARD_PASSWORD_HASH is malformed (%w) - refusing to start an unauthenticated dashboard", err)
	}

	username := os.Getenv("DASHBOARD_USERNAME")
	if username == "" {
		username = "admin"
	}

	csrfKey, err := loadOrCreateCSRFKey()
	if err != nil {
		return nil, err
	}

	cfg := &authConfig{
		username:   username,
		hash:       hash,
		sessionTTL: durationFromEnv("DASHBOARD_SESSION_TTL", 12*time.Hour),
		idleTTL:    durationFromEnv("DASHBOARD_IDLE_TTL", 2*time.Hour),
		// Flarops always publishes the dashboard through Traefik, so the peer
		// address is the ingress pod and the real client only appears in
		// X-Forwarded-For. Off by default so a directly-exposed deployment
		// can't have its rate limiting bypassed by a forged header.
		trustProxy:    os.Getenv("DASHBOARD_TRUST_PROXY") == "1",
		secureCookies: os.Getenv("DASHBOARD_ALLOW_INSECURE_COOKIES") != "1",
		csrfKey:       csrfKey,
	}
	if cfg.idleTTL > cfg.sessionTTL {
		cfg.idleTTL = cfg.sessionTTL
	}
	if !cfg.secureCookies {
		log.Println("auth: WARNING - DASHBOARD_ALLOW_INSECURE_COOKIES=1; session cookies will be sent over plain HTTP. Never use this on a public deployment.")
	}
	return cfg, nil
}

// ---------------------------------------------------------------- sessions

func initAuthSchema() error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS dashboard_sessions (
			token_hash TEXT PRIMARY KEY,
			created_at DATETIME NOT NULL,
			last_seen  DATETIME NOT NULL,
			expires_at DATETIME NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires ON dashboard_sessions(expires_at);
	`)
	return err
}

// The CSRF key used to live only in this process's memory. Sessions outlive
// the process - they are rows in SQLite on a persistent volume - so every
// restart left already-logged-in operators holding sessions whose CSRF tokens
// no longer verified, and logout answered them 403 until they cleared their
// cookies. Keeping the key beside the sessions it authenticates makes the two
// survive together, and lets a second replica agree with the first.
func loadOrCreateCSRFKey() ([]byte, error) {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS dashboard_auth_keys (name TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		return nil, fmt.Errorf("could not open the auth key store: %w", err)
	}

	var encoded string
	err := db.QueryRow(`SELECT value FROM dashboard_auth_keys WHERE name = 'csrf'`).Scan(&encoded)
	if err == nil {
		if key, decodeErr := base64.RawStdEncoding.DecodeString(encoded); decodeErr == nil && len(key) >= 32 {
			return key, nil
		}
		log.Println("auth: stored CSRF key is unusable, issuing a new one")
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("could not seed CSRF key: %w", err)
	}
	// INSERT OR IGNORE, then re-read: two replicas starting at once must end
	// up on the same key rather than each overwriting the other's.
	if _, err := db.Exec(
		`INSERT OR IGNORE INTO dashboard_auth_keys (name, value) VALUES ('csrf', ?)`,
		base64.RawStdEncoding.EncodeToString(key),
	); err != nil {
		return nil, fmt.Errorf("could not persist CSRF key: %w", err)
	}
	if err := db.QueryRow(`SELECT value FROM dashboard_auth_keys WHERE name = 'csrf'`).Scan(&encoded); err != nil {
		return nil, fmt.Errorf("could not read back CSRF key: %w", err)
	}
	stored, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil || len(stored) < 32 {
		return nil, errors.New("stored CSRF key is unusable")
	}
	return stored, nil
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// Sessions are stored by hash for the same reason passwords are: a read of
// the SQLite file on the PVC must not hand over a working session.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func createSession() (string, error) {
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	_, err = db.Exec(
		`INSERT INTO dashboard_sessions (token_hash, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?)`,
		hashToken(token), now, now, now.Add(auth.sessionTTL),
	)
	if err != nil {
		return "", err
	}
	return token, nil
}

// Enforces BOTH bounds server-side: an absolute lifetime the cookie cannot
// outlive, and an idle window. A stolen cookie is therefore useful for at
// most idleTTL of inactivity, regardless of what the client claims.
func sessionIsValid(token string) bool {
	if token == "" {
		return false
	}
	var lastSeen, expiresAt time.Time
	err := db.QueryRow(
		`SELECT last_seen, expires_at FROM dashboard_sessions WHERE token_hash = ?`,
		hashToken(token),
	).Scan(&lastSeen, &expiresAt)
	if err != nil {
		return false
	}

	now := time.Now().UTC()
	if now.After(expiresAt) || now.Sub(lastSeen.UTC()) > auth.idleTTL {
		destroySession(token)
		return false
	}

	// Written only when it is actually stale. Every request passes through
	// here, static assets included, so refreshing on each one meant a SQLite
	// write per asset on a ReadWriteOnce volume to move a timestamp by
	// milliseconds. The idle window is measured in hours; a minute of
	// granularity costs it nothing.
	if now.Sub(lastSeen.UTC()) > sessionActivityWriteInterval {
		if _, err := db.Exec(`UPDATE dashboard_sessions SET last_seen = ? WHERE token_hash = ?`, now, hashToken(token)); err != nil {
			log.Println("auth: could not refresh session activity:", err)
		}
	}
	return true
}

func destroySession(token string) {
	if token == "" {
		return
	}
	if _, err := db.Exec(`DELETE FROM dashboard_sessions WHERE token_hash = ?`, hashToken(token)); err != nil {
		log.Println("auth: could not delete session:", err)
	}
}

func startSessionPurge() {
	purge := func() {
		if _, err := db.Exec(`DELETE FROM dashboard_sessions WHERE expires_at < ?`, time.Now().UTC()); err != nil {
			log.Println("auth: could not purge expired sessions:", err)
		}
	}
	purge()
	ticker := time.NewTicker(time.Hour)
	go func() {
		for range ticker.C {
			purge()
		}
	}()
}

// -------------------------------------------------------------------- CSRF

// For a logged-in session the CSRF token is derived from the session token
// rather than stored, so there is no second secret to leak and no way for the
// two to drift apart. SameSite=Strict already blocks the cross-site POST;
// this is the layer that still holds if a browser ever doesn't honour it.
func sessionCSRFToken(sessionToken string) string {
	mac := hmac.New(sha256.New, auth.csrfKey)
	mac.Write([]byte(sessionToken))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func csrfTokenMatches(expected, got string) bool {
	return subtle.ConstantTimeCompare([]byte(expected), []byte(got)) == 1
}

// ---------------------------------------------------------- rate limiting

type windowCounter struct {
	count int
	start time.Time
}

// Fixed-window failure counter. Deliberately counts only FAILURES, so an
// operator using the dashboard normally never approaches the limit while a
// brute-force run hits it within seconds.
type attemptLimiter struct {
	mu       sync.Mutex
	window   time.Duration
	max      int
	counters map[string]*windowCounter
}

func newAttemptLimiter(max int, window time.Duration) *attemptLimiter {
	return &attemptLimiter{window: window, max: max, counters: map[string]*windowCounter{}}
}

func (l *attemptLimiter) retryAfter(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	c, ok := l.counters[key]
	if !ok {
		return 0
	}
	if time.Since(c.start) >= l.window {
		delete(l.counters, key)
		return 0
	}
	if c.count < l.max {
		return 0
	}
	return l.window - time.Since(c.start)
}

func (l *attemptLimiter) recordFailure(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	c, ok := l.counters[key]
	if !ok || time.Since(c.start) >= l.window {
		l.counters[key] = &windowCounter{count: 1, start: time.Now()}
		return
	}
	c.count++
}

func (l *attemptLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.counters, key)
}

func (l *attemptLimiter) cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, c := range l.counters {
		if time.Since(c.start) >= l.window {
			delete(l.counters, k)
		}
	}
}

// The per-IP limiter is the credential protection: it caps a single source at
// 10 guesses per quarter hour, and an attacker who trips it only locks out
// themselves.
//
// The global limiter is deliberately NOT set anywhere near as tight. A hard
// global lockout protects against distributed guessing, but it is also a
// lever any anonymous client can pull to lock the operator out of their own
// dashboard - and cheaply, since it needs only as many requests as the
// threshold. Set well above anything a real operator generates, it stays what
// it should be: a backstop that bounds how much CPU the deliberately
// expensive PBKDF2 verification can be made to burn, rather than a second
// credential control. The password Flarops issues carries ~144 bits of
// entropy, so distributed guessing is not the threat this needs to stop.
var (
	perIPLimiter  = newAttemptLimiter(10, 15*time.Minute)
	globalLimiter = newAttemptLimiter(500, 15*time.Minute)
)

func startLimiterCleanup() {
	ticker := time.NewTicker(10 * time.Minute)
	go func() {
		for range ticker.C {
			perIPLimiter.cleanup()
			globalLimiter.cleanup()
		}
	}()
}

// With one trusted proxy in front (Traefik), the RIGHTMOST X-Forwarded-For
// entry is the address that proxy actually observed - everything to its left
// is whatever the client claimed and must not be trusted for rate limiting,
// or an attacker would simply rotate a forged header to get unlimited tries.
func clientIP(r *http.Request) string {
	if auth.trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			candidate := strings.TrimSpace(parts[len(parts)-1])
			if ip := net.ParseIP(candidate); ip != nil {
				return ip.String()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---------------------------------------------------------------- handlers

type loginPageData struct {
	Nonce     string
	CSRFToken string
	Error     string
}

// URL-safe alphabet on purpose: standard base64's "+" and "/" are escaped by
// html/template inside an attribute value ("+" becomes "&#43;"), so the nonce
// on the tag would no longer be byte-identical to the one in the header.
// Browsers decode the entity before matching, but a CSP that only works
// because of that is one parser change away from silently failing open.
// "-" and "_" are valid in a CSP nonce and need no escaping.
func newNonce() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func (c *authConfig) setCookie(w http.ResponseWriter, name, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   c.secureCookies,
		SameSite: http.SameSiteStrictMode,
	})
}

func (c *authConfig) clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   c.secureCookies,
		SameSite: http.SameSiteStrictMode,
	})
}

func cookieValue(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return c.Value
}

func renderLogin(w http.ResponseWriter, status int, errMsg string, csrfToken string) {
	nonce := newNonce()
	w.Header().Set("Content-Security-Policy", strictPageCSP(nonce))
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if err := authTemplates.ExecuteTemplate(w, "login.html", loginPageData{
		Nonce:     nonce,
		CSRFToken: csrfToken,
		Error:     errMsg,
	}); err != nil {
		log.Println("auth: could not render login page:", err)
	}
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		if sessionIsValid(cookieValue(r, auth.sessionCookieName())) {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		token, err := randomToken()
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		auth.setCookie(w, auth.csrfCookieName(), token, int((30 * time.Minute).Seconds()))
		renderLogin(w, http.StatusOK, "", token)

	case http.MethodPost:
		handleLoginPost(w, r)

	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleLoginPost(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)

	// Checked BEFORE the password is verified: the key derivation is
	// deliberately expensive, so an unthrottled login endpoint would be a CPU
	// exhaustion vector on top of being brute-forceable.
	if wait := perIPLimiter.retryAfter(ip); wait > 0 {
		tooManyAttempts(w, wait)
		return
	}
	if wait := globalLimiter.retryAfter("global"); wait > 0 {
		tooManyAttempts(w, wait)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxLoginBodyBytes)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// Double-submit: the token in the form has to match the one in a cookie
	// that only a same-site request could have sent back.
	csrfCookie := cookieValue(r, auth.csrfCookieName())
	csrfField := r.PostFormValue("csrf_token")
	if csrfCookie == "" || !csrfTokenMatches(csrfCookie, csrfField) {
		// Nothing sensitive is revealed here - this is almost always a stale
		// tab rather than an attack, so re-issue and let the operator retry.
		fresh, err := randomToken()
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		auth.setCookie(w, auth.csrfCookieName(), fresh, int((30 * time.Minute).Seconds()))
		renderLogin(w, http.StatusBadRequest, "Session expired. Please try again.", fresh)
		return
	}

	username := r.PostFormValue("username")
	password := r.PostFormValue("password")

	// Both comparisons always run, and the key derivation is performed even
	// when the username is wrong, so response time never reveals which half of
	// the credential was correct.
	usernameOK := subtle.ConstantTimeCompare([]byte(username), []byte(auth.username)) == 1
	passwordOK, verifyErr := auth.hash.verify(password)
	if errors.Is(verifyErr, errVerifierBusy) {
		// Not counted as a failed attempt: the credential was never read, and
		// counting it would let a burst of anonymous requests exhaust the
		// operator's own allowance.
		tooManyAttempts(w, 5*time.Second)
		return
	}

	if !usernameOK || !passwordOK {
		perIPLimiter.recordFailure(ip)
		globalLimiter.recordFailure("global")
		log.Printf("auth: failed login attempt from %s", ip)

		fresh, err := randomToken()
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		auth.setCookie(w, auth.csrfCookieName(), fresh, int((30 * time.Minute).Seconds()))
		renderLogin(w, http.StatusUnauthorized, "Incorrect username or password.", fresh)
		return
	}

	// Session fixation: the session is only ever created AFTER the credential
	// is proven, so a token planted beforehand can never become authenticated.
	token, err := createSession()
	if err != nil {
		log.Println("auth: could not create session:", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	perIPLimiter.reset(ip)
	auth.clearCookie(w, auth.csrfCookieName())
	auth.setCookie(w, auth.sessionCookieName(), token, int(auth.sessionTTL.Seconds()))
	log.Printf("auth: successful login from %s", ip)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func tooManyAttempts(w http.ResponseWriter, wait time.Duration) {
	seconds := int(wait.Seconds()) + 1
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	http.Error(w, "Too many login attempts. Try again later.", http.StatusTooManyRequests)
}

type logoutPageData struct {
	Nonce     string
	CSRFToken string
}

// GET renders a confirmation form; only POST destroys the session. A logout
// reachable by GET can be triggered by any third-party page embedding an
// <img src=".../logout">, which is a nuisance rather than a breach but is
// trivially avoidable.
func handleLogout(w http.ResponseWriter, r *http.Request) {
	sessionToken := cookieValue(r, auth.sessionCookieName())

	switch r.Method {
	case http.MethodGet:
		if !sessionIsValid(sessionToken) {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		nonce := newNonce()
		w.Header().Set("Content-Security-Policy", strictPageCSP(nonce))
		w.Header().Set("Cache-Control", "no-store, max-age=0")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := authTemplates.ExecuteTemplate(w, "logout.html", logoutPageData{
			Nonce:     nonce,
			CSRFToken: sessionCSRFToken(sessionToken),
		}); err != nil {
			log.Println("auth: could not render logout page:", err)
		}

	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, maxLoginBodyBytes)
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if !sessionIsValid(sessionToken) || !csrfTokenMatches(sessionCSRFToken(sessionToken), r.PostFormValue("csrf_token")) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		destroySession(sessionToken)
		auth.clearCookie(w, auth.sessionCookieName())
		http.Redirect(w, r, "/login", http.StatusSeeOther)

	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// ------------------------------------------------------------- middleware

func requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !sessionIsValid(cookieValue(r, auth.sessionCookieName())) {
			// The WebSocket endpoint gets a status rather than a redirect -
			// a 303 to an HTML page is meaningless to a WebSocket client and
			// would just surface as an opaque handshake failure.
			if r.URL.Path == "/ws" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			w.Header().Set("Cache-Control", "no-store, max-age=0")
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func strictPageCSP(nonce string) string {
	return strings.Join([]string{
		"default-src 'none'",
		"style-src 'nonce-" + nonce + "'",
		"script-src 'nonce-" + nonce + "'",
		"img-src 'self' data:",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
	}, "; ")
}

// The dashboard page itself carries a large inline <style>/<script> pair that
// predates this work, so it still needs 'unsafe-inline'. Everything else is
// locked down, and the page is now reachable only with a session.
// Only the characters a host (with optional port, including a bracketed IPv6
// literal) can legally contain. r.Host arrives from the client, and it is
// about to be written into a response header.
var safeHostRegexp = regexp.MustCompile(`^[A-Za-z0-9.\-:\[\]]{1,255}$`)

func appPageCSP(r *http.Request) string {
	return strings.Join([]string{
		"default-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"script-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		// "ws:" and "wss:" are scheme sources - they match EVERY host, not
		// just this one. Next to the 'unsafe-inline' this page still needs,
		// that left an injected script free to stream whatever it read to a
		// socket anywhere on the internet. 'self' already covers a same-origin
		// ws:// or wss:// connection, which is the only one this page opens.
		// The WebSocket origin is named EXPLICITLY rather than left to 'self'.
		// CSP Level 3 says 'self' matches a same-host wss:// URL, and the
		// earlier version of this line relied on that - but Firefox does not
		// implement it, and it reports the resulting block as
		// NS_ERROR_UNKNOWN_HOST rather than as a CSP violation, so the live
		// dashboard simply never received an update and nothing said why.
		// Naming the host keeps the policy exactly as tight (no scheme
		// wildcard, no third-party host) while actually working.
		"connect-src 'self'" + socketSource(r),
		"form-action 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
	}, "; ")
}

// The one socket this page opens: same host, same port, and wss only when the
// page itself was served over TLS. An unparseable Host contributes nothing, so
// a malformed request cannot widen the policy.
func socketSource(r *http.Request) string {
	if r == nil || !safeHostRegexp.MatchString(r.Host) {
		return ""
	}
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		return " wss://" + r.Host
	}
	return " ws://" + r.Host + " wss://" + r.Host
}

func securityHeaders(next http.Handler, csp func(*http.Request) string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		if csp != nil {
			h.Set("Content-Security-Policy", csp(r))
		}
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		if auth != nil && auth.secureCookies {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// A WebSocket handshake is not subject to the same-origin policy, so without
// this check any third-party page an authenticated operator visits could open
// wss://dashboard.../ws with their cookies attached and stream the entire
// cluster state. SameSite=Strict blocks that in modern browsers; this closes
// it regardless of cookie policy.
func originIsSameHost(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// Non-browser clients (and same-origin navigations in some cases)
		// omit Origin entirely; those carry no ambient cross-site authority.
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

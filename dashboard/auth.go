package main

// Authentication for the dashboard: one operator credential, fail-closed when misconfigured, and
// protected against brute force, CSRF and cross-site WebSocket hijacking.

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

	// PBKDF2-HMAC-SHA256 at OWASP's iteration count, on the standard library alone.
	pbkdf2Iterations = 600000
	pbkdf2KeyLen     = 32
	pbkdf2SaltLen    = 16

	maxLoginBodyBytes = 4 << 10

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

type passwordHash struct {
	iterations int
	salt       []byte
	key        []byte
}

// PBKDF2 (RFC 8018 5.2) over crypto/hmac.
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

// Encoded form: pbkdf2-sha256$i=<n>$<b64 salt>$<b64 key>.
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
	// A rewritten environment must not be able to weaken the hash.
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

// Verifications run one at a time, and at most this many may wait: the KDF is the expensive part.
const maxQueuedVerifications = 4

var (
	verifyGate    = make(chan struct{}, 1)
	verifyWaiting atomic.Int32
)

// Not a failed attempt: the credential was never examined.
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

// No configuration mistake may serve the dashboard unauthenticated.
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
		// Behind Traefik the client is in X-Forwarded-For; off by default so a forged header cannot bypass
		// rate limiting on a directly exposed deployment.
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

// The CSRF key lives beside the sessions it authenticates, so both survive a restart.
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
	// Two replicas starting at once must agree on one key.
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

// Sessions are stored by hash: reading the database must not hand over a working session.
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

// Both an absolute lifetime and an idle window, enforced server-side.
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

	// Written only when stale: every request passes through here.
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

// Derived from the session token: no second secret to store.
func sessionCSRFToken(sessionToken string) string {
	mac := hmac.New(sha256.New, auth.csrfKey)
	mac.Write([]byte(sessionToken))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func csrfTokenMatches(expected, got string) bool {
	return subtle.ConstantTimeCompare([]byte(expected), []byte(got)) == 1
}

type windowCounter struct {
	count int
	start time.Time
}

// Counts only failures.
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

// Per-IP limiting is the credential protection; the global limiter is only a CPU backstop, so it
// cannot be used to lock the operator out.
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

// With one trusted proxy, only the rightmost X-Forwarded-For entry is real.
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

type loginPageData struct {
	Nonce     string
	CSRFToken string
	Error     string
}

// URL-safe alphabet: html/template would escape "+" in the nonce attribute.
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

	// Rate limit before the expensive verification.
	if wait := perIPLimiter.retryAfter(ip); wait > 0 {
		tooManyAttempts(w, wait)
		return
	}
	// The global limiter only logs; gating on it would let distributed noise lock the operator out.
	if wait := globalLimiter.retryAfter("global"); wait > 0 {
		log.Printf("auth: global failure rate is elevated (%s remaining in window)", wait.Truncate(time.Second))
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxLoginBodyBytes)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// Double-submit CSRF check.
	csrfCookie := cookieValue(r, auth.csrfCookieName())
	csrfField := r.PostFormValue("csrf_token")
	if csrfCookie == "" || !csrfTokenMatches(csrfCookie, csrfField) {
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

	// Both halves are always checked, so timing reveals neither.
	usernameOK := subtle.ConstantTimeCompare([]byte(username), []byte(auth.username)) == 1
	passwordOK, verifyErr := auth.hash.verify(password)
	if errors.Is(verifyErr, errVerifierBusy) {
		// Charged to the source address, or the queue could be kept full for free.
		perIPLimiter.recordFailure(ip)
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

	// A session exists only after the credential is proven (no fixation).
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

// Only POST logs out: a GET could be triggered by any page.
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

func requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !sessionIsValid(cookieValue(r, auth.sessionCookieName())) {
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

// The dashboard page still needs 'unsafe-inline'; everything else is locked down.
var safeHostRegexp = regexp.MustCompile(`^[A-Za-z0-9.\-:\[\]]{1,255}$`)

func appPageCSP(r *http.Request) string {
	return strings.Join([]string{
		"default-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"script-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		// Name the socket origin explicitly: scheme sources (ws:/wss:) match every host, and Firefox does not
		// match 'self' for wss.
		"connect-src 'self'" + socketSource(r),
		"form-action 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
	}, "; ")
}

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

// A WebSocket handshake is not covered by the same-origin policy.
func originIsSameHost(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

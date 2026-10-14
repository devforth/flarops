package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type countingReader struct {
	r io.Reader
	n int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

// A rate-limited address still cannot make the server read a large body.
func TestRateLimitedLoginReadsABoundedBody(t *testing.T) {
	saved := auth
	auth = &authConfig{username: "admin"}
	defer func() { auth = saved }()
	const ip = "192.0.2.7"
	for i := 0; i < 20; i++ {
		perIPLimiter.recordFailure(ip)
	}
	defer perIPLimiter.reset(ip)

	body := &countingReader{r: strings.NewReader("username=" + strings.Repeat("a", 8<<20))}
	req := httptest.NewRequest(http.MethodPost, "/login", body)
	req.RemoteAddr = ip + ":1234"
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	handleLoginPost(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status %d, want 429", rec.Code)
	}
	if body.n > maxLoginBodyBytes+4096 {
		t.Fatalf("read %d bytes of the body, want at most about %d", body.n, maxLoginBodyBytes)
	}
}

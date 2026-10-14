package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// A data frame sent longer than the write wait after a ping still goes out: the ping's deadline is
// not inherited.
func TestDataFramesOutliveThePingDeadline(t *testing.T) {
	saved := wsWriteWait
	wsWriteWait = 50 * time.Millisecond
	defer func() { wsWriteWait = saved }()

	send := make(chan []byte, 1)
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		writePump(conn, send, 150*time.Millisecond)
	}))
	defer srv.Close()

	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	go func() {
		time.Sleep(260 * time.Millisecond) // a ping at 150ms set a deadline of 200ms
		send <- []byte("frame")
		time.Sleep(50 * time.Millisecond)
		close(send)
	}()
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := client.ReadMessage()
	if err != nil || string(msg) != "frame" {
		t.Fatalf("got %q, %v; want the frame", msg, err)
	}
	if _, _, err := client.ReadMessage(); !websocket.IsCloseError(err, websocket.CloseNoStatusReceived) {
		t.Fatalf("after the channel closed: %v, want a close frame", err)
	}
}

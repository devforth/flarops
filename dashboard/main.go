package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed static/*
var content embed.FS

// Only same-host origins (see originIsSameHost).
var upgrader = websocket.Upgrader{
	CheckOrigin: originIsSameHost,
}

type Client struct {
	conn *websocket.Conn
	send chan []byte
	// Re-checked per frame: requireAuth only runs on the handshake.
	sessionToken string
}

type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	mu         sync.Mutex
}

var hub = Hub{
	clients:    make(map[*Client]bool),
	broadcast:  make(chan []byte),
	register:   make(chan *Client),
	unregister: make(chan *Client),
}

func (h *Hub) run() {
	for {
		select {
		case client := <-h.register:
			h.clients[client] = true
		case client := <-h.unregister:
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
			}
		case message := <-h.broadcast:
			for client := range h.clients {
				if !sessionIsValid(client.sessionToken) {
					close(client.send)
					delete(h.clients, client)
					continue
				}
				select {
				case client.send <- message:
				default:
					close(client.send)
					delete(h.clients, client)
				}
			}
		}
	}
}

func serveWs(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("upgrade err:", err)
		return
	}
	client := &Client{
		conn:         conn,
		send:         make(chan []byte, 256),
		sessionToken: cookieValue(r, auth.sessionCookieName()),
	}
	hub.register <- client

	conn.SetReadLimit(4 << 10)
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	})

	go func() {
		defer func() {
			hub.unregister <- client
			conn.Close()
		}()
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Printf("error: %v", err)
				}
				break
			}
		}
	}()

	go func() {
		ping := time.NewTicker(30 * time.Second)
		defer func() {
			ping.Stop()
			conn.Close()
		}()
		for {
			select {
			case <-ping.C:
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			case message, ok := <-client.send:
				if !ok {
					conn.WriteMessage(websocket.CloseMessage, []byte{})
					return
				}
				w, err := conn.NextWriter(websocket.TextMessage)
				if err != nil {
					return
				}
				w.Write(message)
				if err := w.Close(); err != nil {
					return
				}
			}
		}
	}()
}

func main() {
	// The same binary is the node-agent DaemonSet, which shares nothing with the dashboard.
	if os.Getenv("FLAROPS_NODE_AGENT") == "1" {
		runNodeAgent()
		return
	}

	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "flarops_metrics.db"
	}
	if err := initDB(dbPath); err != nil {
		log.Fatal("Failed to initialize database: ", err)
	}
	startSampleRetention()

	// Fatal on failure: never come up unauthenticated.
	authCfg, err := loadAuthConfig()
	if err != nil {
		log.Fatal("auth: ", err)
	}
	auth = authCfg
	if err := initAuthSchema(); err != nil {
		log.Fatal("auth: failed to initialize session store: ", err)
	}
	startSessionPurge()
	startLimiterCleanup()

	go startPriceFetcher()

	k8sClient, err := NewK8sClient()
	if err != nil {
		log.Fatal("Failed to create k8s client: ", err)
	}

	go hub.run()
	go startCollector(k8sClient)

	// Loopback only; CI reaches it with kubectl exec.
	startCapacityServer()

	staticFS, err := fs.Sub(content, "static")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()

	mux.Handle("/login", securityHeaders(http.HandlerFunc(handleLogin), nil))
	mux.Handle("/logout", securityHeaders(http.HandlerFunc(handleLogout), nil))

	// Guard on "/" so a route added later is authenticated by default.
	app := http.NewServeMux()
	app.HandleFunc("/ws", serveWs)
	app.Handle("/", http.FileServer(http.FS(staticFS)))
	mux.Handle("/", securityHeaders(requireAuth(app), appPageCSP))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
		// These do not apply to a hijacked WebSocket connection.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	fmt.Printf("Dashboard running on port %s\n", port)
	if err := server.ListenAndServe(); err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}

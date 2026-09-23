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

// A WebSocket handshake is exempt from the same-origin policy, so accepting
// every Origin meant any page an authenticated operator happened to visit
// could open this socket with their cookies attached and stream the entire
// cluster state back to its author. See originIsSameHost in auth.go.
var upgrader = websocket.Upgrader{
	CheckOrigin: originIsSameHost,
}

type Client struct {
	conn *websocket.Conn
	send chan []byte
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
	client := &Client{conn: conn, send: make(chan []byte, 256)}
	hub.register <- client

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
		defer func() {
			conn.Close()
		}()
		for {
			select {
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
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "flarops_metrics.db"
	}
	if err := initDB(dbPath); err != nil {
		log.Fatal("Failed to initialize database: ", err)
	}
	startSampleRetention()

	// Loaded before anything starts listening, and fatal on failure: a
	// dashboard that cannot authenticate must not come up at all rather than
	// come up open. See loadAuthConfig in auth.go.
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

	// Fetch pricing data in the background instead of blocking startup on it -
	// a hung or slow third-party endpoint (instances.vantage.sh) must not delay
	// the k8s client, websocket hub, or HTTP server from coming up.
	go startPriceFetcher()

	k8sClient, err := NewK8sClient()
	if err != nil {
		log.Fatal("Failed to create k8s client: ", err)
	}

	go hub.run()
	go startCollector(k8sClient)

	// Loopback only, and never behind the Ingress: reachable solely from
	// inside this pod, which is what "kubectl exec" gives the CI job. See
	// capacity.go.
	startCapacityServer()

	staticFS, err := fs.Sub(content, "static")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()

	// The only two routes reachable without a session. Both are rendered from
	// templates with a per-response CSP nonce, so neither depends on
	// 'unsafe-inline'.
	mux.Handle("/login", securityHeaders(http.HandlerFunc(handleLogin), nil))
	mux.Handle("/logout", securityHeaders(http.HandlerFunc(handleLogout), nil))

	// Everything else - the dashboard itself and the live metrics socket -
	// goes through requireAuth. Registering the guard on "/" rather than on
	// individual assets means a route added later is authenticated by
	// default instead of accidentally public.
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
		// gorilla/websocket hijacks the connection on upgrade, so once /ws is
		// streaming these server-level timeouts no longer apply to it (net/http
		// stops managing deadlines on a hijacked connection) - they only guard
		// the plain static-file responses and the upgrade handshake itself.
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

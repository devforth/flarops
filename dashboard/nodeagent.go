package main

// The node agent: one node's disk usage, over HTTP, with no ServiceAccount token and no API access.
// It replaces `get nodes/proxy`, which would also authorize exec into every container.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"syscall"
	"time"
)

type nodeDisk struct {
	TotalBytes uint64 `json:"totalBytes"`
	UsedBytes  uint64 `json:"usedBytes"`
}

func hostRoot() string {
	if p := os.Getenv("FLAROPS_HOST_ROOT"); p != "" {
		return p
	}
	return "/host"
}

func readNodeDisk(mountPoint string) (nodeDisk, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(mountPoint, &st); err != nil {
		return nodeDisk{}, err
	}
	blockSize := uint64(st.Bsize)
	total := st.Blocks * blockSize
	used := (st.Blocks - st.Bfree) * blockSize
	return nodeDisk{TotalBytes: total, UsedBytes: used}, nil
}

func runNodeAgent() {
	addr := os.Getenv("NODE_AGENT_ADDR")
	if addr == "" {
		addr = ":9101"
	}
	mount := hostRoot()

	mux := http.NewServeMux()
	mux.HandleFunc("/disk", func(w http.ResponseWriter, r *http.Request) {
		disk, err := readNodeDisk(mount)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprintf(w, `{"error":%q}`, err.Error())
			return
		}
		_ = json.NewEncoder(w).Encode(disk)
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "ok\n")
	})

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
	}
	log.Printf("node agent serving %s from %s", addr, mount)
	log.Fatal(server.ListenAndServe())
}

package main

// The node agent.
//
// Node filesystem figures used to come from the kubelet's stats/summary,
// reached through the API server with `get` on nodes/proxy. That one RBAC verb
// is far more than it looks: the API server maps a GET on a proxy subresource
// to `get`, and the kubelet serves /exec on GET as well as POST - so the right
// to read a disk gauge is also the right to
//
//	GET /api/v1/nodes/<node>/proxy/exec/<ns>/<pod>/<container>?command=sh
//
// on every container in the cluster. RBAC cannot scope a subresource to one
// path, so the only way to keep the gauge without that authority is to stop
// asking the kubelet.
//
// This agent runs as a DaemonSet, mounts the host root read-only, and answers
// exactly two numbers over loopback-free HTTP on the pod network. It has no
// ServiceAccount token and makes no API calls: compromising it yields the size
// of a disk.

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

// hostRoot is where the DaemonSet mounts the node's filesystem. Reported
// figures are for that mount point, which is the node's root volume.
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
	// Used as the filesystem itself reports it: everything not free, which
	// includes the root-reserved blocks. That matches what "df" shows for the
	// disk as a whole rather than what an unprivileged writer could still use.
	used := (st.Blocks - st.Bfree) * blockSize
	return nodeDisk{TotalBytes: total, UsedBytes: used}, nil
}

// runNodeAgent serves the disk figures and never returns.
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

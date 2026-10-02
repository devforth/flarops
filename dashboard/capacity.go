package main

// A capacity oracle for CI, on a loopback-only listener: reaching it requires `kubectl exec`, which
// is the whole authorization story.

import (
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// A capsule grows after start and its page cache is charged to it: plan with headroom.
const CapsuleHeadroom = 0.15

// Never 0: the page divides by it.
func EffectiveMiB(mib int) int {
	if mib < 0 {
		mib = 0
	}
	v := int(math.Ceil(float64(mib) * (1 + CapsuleHeadroom)))
	if v < 1 {
		return 1
	}
	return v
}

var (
	latestMu   sync.RWMutex
	latestData *DashboardData
	latestAt   time.Time
)

func publishSnapshot(d DashboardData) {
	latestMu.Lock()
	defer latestMu.Unlock()
	copied := d
	latestData = &copied
	latestAt = time.Now()
}

func snapshot() (*DashboardData, time.Time) {
	latestMu.RLock()
	defer latestMu.RUnlock()
	return latestData, latestAt
}

// Free memory a NEW pod can take without eviction: the smaller of physical free minus the kubelet's
// reserve, and allocatable minus what pods use.
func FreeForSchedulingMiB(h HostState) int {
	if h.RamTotal <= 0 || h.RamAllocatable <= 0 {
		return 0
	}
	podsUsed := 0
	for _, c := range h.Capsules {
		podsUsed += c.Ram
	}

	physical := (h.RamTotal - h.RamUsed) - ReservedMiB(h)
	schedulable := h.RamAllocatable - podsUsed
	free := physical
	if schedulable < free {
		free = schedulable
	}
	if free < 0 {
		return 0
	}
	return free
}

func ReservedMiB(h HostState) int {
	if h.RamTotal <= 0 || h.RamAllocatable <= 0 {
		return 0
	}
	if r := h.RamTotal - h.RamAllocatable; r > 0 {
		return r
	}
	return 0
}

// A capsule promised a node but not yet visible: held so two pipelines cannot be sent to one slot.
type reservation struct {
	node    string
	mib     int
	expires time.Time
}

// Long enough for a capsule to become measurable.
const reservationTTL = 5 * time.Minute

var (
	reservationsMu sync.Mutex
	reservations   = map[string]*reservation{}
)

func reserve(key, node string, mib int) {
	reservationsMu.Lock()
	defer reservationsMu.Unlock()
	reservations[key] = &reservation{node: node, mib: mib, expires: time.Now().Add(reservationTTL)}
}

// exceptKey: the caller's own promise does not count against it on a retry.
func reservedOn(node, exceptKey string) int {
	reservationsMu.Lock()
	defer reservationsMu.Unlock()
	now := time.Now()
	total := 0
	for k, r := range reservations {
		if now.After(r.expires) {
			delete(reservations, k)
			continue
		}
		if k == exceptKey {
			continue
		}
		if r.node == node {
			total += r.mib
		}
	}
	return total
}

func releaseReservation(key string) {
	reservationsMu.Lock()
	defer reservationsMu.Unlock()
	delete(reservations, key)
}

type placement struct {
	Fits        bool
	Node        string
	FreeMiB     int
	RequiredMiB int
}

// The same rule the dashboard draws.
func planPlacement(d *DashboardData, requestMiB int, callerKey string) placement {
	required := EffectiveMiB(requestMiB)
	best := placement{RequiredMiB: required}
	for _, h := range d.Hosts {
		// Unschedulable or unmeasured nodes look emptiest and are the worst targets.
		if !h.Schedulable || !h.MetricsKnown || h.RamAllocatable <= 0 {
			continue
		}
		// Promised memory is not free.
		free := FreeForSchedulingMiB(h) - reservedOn(h.ID, callerKey)
		if free < 0 {
			free = 0
		}
		if free > best.FreeMiB {
			best.FreeMiB = free
			best.Node = h.ID
		}
	}
	best.Fits = best.Node != "" && best.FreeMiB >= required
	return best
}

func largestCapsuleMiB(d *DashboardData) int {
	largest := 0
	for _, h := range d.Hosts {
		for _, c := range h.Capsules {
			if c.Ram > largest {
				largest = c.Ram
			}
		}
	}
	return largest
}

// Plain text, first line is the verdict, so a shell can read it.
func handleCapacity(w http.ResponseWriter, r *http.Request) {
	d, at := snapshot()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")

	if d == nil {
		// Never "yes" from no data.
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, "unknown\nreason=no fleet data collected yet\n")
		return
	}
	// Stale data is as bad as none.
	if age := time.Since(at); age > 2*time.Minute {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprintf(w, "unknown\nreason=fleet data is %ds old\n", int(age.Seconds()))
		return
	}

	requested := 0
	if raw := r.URL.Query().Get("mib"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, "unknown\nreason=malformed mib parameter %q\n", raw)
			return
		}
		requested = parsed
	} else {
		requested = largestCapsuleMiB(d)
	}

	callerKey := r.URL.Query().Get("for")
	p := planPlacement(d, requested, callerKey)
	verdict := "no"
	if p.Fits {
		verdict = "yes"
		// A "yes" reserves the node until the capsule appears.
		key := callerKey
		if key == "" {
			key = "anon:" + p.Node
		}
		reserve(key, p.Node, p.RequiredMiB)
	}
	reserved := 0
	for _, h := range d.Hosts {
		if h.ID == p.Node {
			reserved = ReservedMiB(h)
		}
	}
	fmt.Fprintf(w, "%s\nnode=%s\nfree_mib=%d\nreserved_mib=%d\nrequested_mib=%d\nrequired_mib=%d\nheadroom_pct=%d\n",
		verdict, p.Node, p.FreeMiB, reserved, requested, p.RequiredMiB, int(CapsuleHeadroom*100))
}

// Its own listener, never reachable through the Ingress.
func startCapacityServer() {
	addr := os.Getenv("CAPACITY_ADDR")
	if addr == "" {
		addr = "127.0.0.1:9090"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/capacity", handleCapacity)
	mux.HandleFunc("/release", func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.Query().Get("for")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if key == "" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, "missing 'for' parameter\n")
			return
		}
		releaseReservation(key)
		fmt.Fprint(w, "released\n")
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

	go func() {
		log.Printf("capacity oracle listening on %s", addr)
		if err := server.ListenAndServe(); err != nil {
			log.Println("capacity oracle stopped:", err)
		}
	}()
}

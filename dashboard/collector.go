package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
)

type NodeStatsSummary struct {
	Node struct {
		Fs struct {
			CapacityBytes int64 `json:"capacityBytes"`
			UsedBytes     int64 `json:"usedBytes"`
		} `json:"fs"`
	} `json:"node"`
	Pods []struct {
		PodRef struct {
			Namespace string `json:"namespace"`
		} `json:"podRef"`
		Volume []struct {
			PvcRef *struct {
				Name string `json:"name"`
			} `json:"pvcRef"`
			CapacityBytes int64 `json:"capacityBytes"`
			UsedBytes     int64 `json:"usedBytes"`
		} `json:"volume"`
	} `json:"pods"`
}

// Shared client with a short timeout: one wedged agent cannot stall a cycle.
var nodeAgentClient = &http.Client{Timeout: 3 * time.Second}

func fetchNodeDisk(podIP string) (nodeDisk, error) {
	port := os.Getenv("NODE_AGENT_PORT")
	if port == "" {
		port = "9101"
	}
	resp, err := nodeAgentClient.Get("http://" + net.JoinHostPort(podIP, port) + "/disk")
	if err != nil {
		return nodeDisk{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nodeDisk{}, fmt.Errorf("node agent returned %s", resp.Status)
	}
	var disk nodeDisk
	if err := json.NewDecoder(resp.Body).Decode(&disk); err != nil {
		return nodeDisk{}, err
	}
	return disk, nil
}

// A gap longer than this between samples is billed as this much: the dashboard was likely down or
// asleep, and minutes it was not running are not counted.
const maxSampleGap = 10 * time.Minute

// How much time a sample taken now stands for, and whether one is due: one a minute, billed for the
// actual time since the last recorded one, so a slow or failed cycle loses no time. The first after a
// start counts as one minute.
func sampleElapsed(now, lastRecorded time.Time) (time.Duration, bool) {
	if lastRecorded.IsZero() {
		return time.Minute, true
	}
	gap := now.Sub(lastRecorded)
	if gap < time.Minute {
		return 0, false
	}
	if gap > maxSampleGap {
		gap = maxSampleGap
	}
	return gap, true
}

func startCollector(k8s *K8sClient) {
	var lastData []byte
	var lastRecorded time.Time
	for {
		now := time.Now()
		elapsed, due := sampleElapsed(now, lastRecorded)
		if !due {
			elapsed = 0
		}

		data, err := buildDashboardData(k8s, now, elapsed)
		if err != nil {
			log.Println("error building dashboard data:", err)
			if lastData != nil {
				hub.broadcast <- lastData
			}
		} else {
			if due {
				lastRecorded = now
			}
			// The capacity oracle reports this exact view.
			publishSnapshot(data)
			b, marshalErr := json.Marshal(data)
			if marshalErr != nil {
				log.Println("error marshaling data:", marshalErr)
			} else {
				lastData = b
				hub.broadcast <- b
			}
		}

		time.Sleep(2 * time.Second)
	}
}

// The environments' running costs, which read their whole history: refreshed once a minute, after the
// minute's samples are written, not on every two-second cycle.
var (
	costLifeCache = map[string]float64{}
	costLifeAt    time.Time
)

// sampleElapsed > 0: record a sample standing for that much time.
func buildDashboardData(k8s *K8sClient, now time.Time, sampleElapsed time.Duration) (DashboardData, error) {
	baseDomain := os.Getenv("DOMAIN")

	defaultRegion := os.Getenv("AWS_REGION")
	if defaultRegion == "" {
		defaultRegion = "us-west-2"
	}

	// Instance type and volume size come from Terraform's outputs via the chart.
	defaultInstanceType := os.Getenv("FLAROPS_DEFAULT_INSTANCE_TYPE")

	ebsGB := 0.0
	if v := os.Getenv("FLAROPS_EBS_GB"); v != "" {
		if parsed, err := strconv.ParseFloat(v, 64); err == nil && parsed > 0 {
			ebsGB = parsed
		}
	}
	if defaultInstanceType == "" || ebsGB == 0 {
		log.Println("collector: FLAROPS_DEFAULT_INSTANCE_TYPE/FLAROPS_EBS_GB not set - CI normally fills these from the Terraform outputs; fleet cost will be missing those components")
	}

	dashboardDomain := "dashboard." + hostParent(baseDomain)

	data := DashboardData{
		Fleet: FleetState{
			Domain:    dashboardDomain,
			AppDomain: baseDomain,
			Project:   os.Getenv("FLAROPS_PROJECT"),
		},
		Hosts: []HostState{},
		Queue: []CapsuleState{},
	}

	nodeAgentIPs, agentErr := k8s.GetNodeAgentIPs()
	if agentErr != nil {
		log.Println("collector: could not list node agents:", agentErr)
		nodeAgentIPs = map[string]string{}
	}

	nodes, err := k8s.GetNodes()
	if err != nil {
		return data, err
	}

	log.Printf("Found %d nodes in cache", len(nodes))
	for _, n := range nodes {
		log.Printf("Node: %s", n.Name)
	}

	pods, err := k8s.GetPods()
	if err != nil {
		return data, err
	}

	nodeMetrics, _ := k8s.GetNodeMetrics()
	podMetrics, _ := k8s.GetPodMetrics()

	// Per container of each pod: replicas and DaemonSet pods share container names.
	type usage struct{ Cpu, Ram int }
	podMetricsMap := make(map[string]usage)
	for _, pm := range podMetrics {
		for _, cm := range pm.Containers {
			podMetricsMap[pm.Namespace+"/"+pm.Name+"/"+cm.Name] = usage{
				Cpu: int(cm.Usage.Cpu().MilliValue() / 10), // percent of one core
				Ram: int(cm.Usage.Memory().Value() / (1024 * 1024)),
			}
		}
	}

	nsPods := make(map[string][]*corev1.Pod)
	for _, p := range pods {
		if p.Namespace == "kube-system" || p.Namespace == "default" || p.Namespace == "kube-public" || p.Namespace == "kube-node-lease" {
			continue
		}
		// Flarops' own dashboard and node agents are not part of the application they watch.
		if app := p.Labels["app"]; app == "flarops-dashboard" || app == "flarops-node-agent" {
			continue
		}
		nsPods[p.Namespace] = append(nsPods[p.Namespace], p)
	}

	// An environment's age, which a redeploy's new pods do not reset.
	nsCreated, nsErr := k8s.GetNamespaceCreation()
	if nsErr != nil {
		log.Println("collector: could not list namespaces:", nsErr)
	}

	// Jobs that have succeeded, by namespace/name, with when their latest succeeded pod was created:
	// an earlier failed attempt of such a job is history, not a failure.
	jobSucceeded := map[string]time.Time{}
	for _, p := range pods {
		if p.Status.Phase != corev1.PodSucceeded {
			continue
		}
		if job := ownerOfKind(p, "Job"); job != "" {
			key := p.Namespace + "/" + job
			if t := p.CreationTimestamp.Time; t.After(jobSucceeded[key]) {
				jobSucceeded[key] = t
			}
		}
	}

	pvcs, _ := k8s.GetPVCs()
	nsPVCs := make(map[string][]*corev1.PersistentVolumeClaim)
	for _, pvc := range pvcs {
		// The dashboard's own disk is Flarops', not the application's, like its pods.
		if pvc.Name == "flarops-dashboard-data" {
			continue
		}
		nsPVCs[pvc.Namespace] = append(nsPVCs[pvc.Namespace], pvc)
	}

	hostMap := make(map[string]*HostState)
	unpriced := map[string]bool{}
	unpricedDisk := map[string]bool{}
	ec2CostPerType := map[string]float64{}
	ebsRunRate := 0.0
	for _, n := range nodes {
		ramTotal := int(n.Status.Capacity.Memory().Value() / (1024 * 1024))
		ramAllocatable := int(n.Status.Allocatable.Memory().Value() / (1024 * 1024))
		cpuCores := int(n.Status.Capacity.Cpu().Value())

		ramUsed := 0
		cpuUsed := 0
		metricsKnown := false
		for _, nm := range nodeMetrics {
			if nm.Name == n.Name {
				ramUsed = int(nm.Usage.Memory().Value() / (1024 * 1024))
				cpuUsed = int(nm.Usage.Cpu().MilliValue() / 10)
				metricsKnown = true
			}
		}

		schedulable := schedulableForCapsules(n)

		instanceType := defaultInstanceType
		if t, ok := n.Labels["flarops.com/instance-type"]; ok && t != "" {
			instanceType = t
		} else if t, ok := n.Labels["node.kubernetes.io/instance-type"]; ok && t != "k3s" {
			instanceType = t
		}
		region := defaultRegion
		if r, ok := n.Labels["topology.kubernetes.io/region"]; ok {
			region = r
		}
		ec2Rate, priceKnown := getEC2HourlyRate(instanceType, region)
		if !priceKnown {
			if instanceType == "" {
				unpriced["an unknown instance type (FLAROPS_DEFAULT_INSTANCE_TYPE is set by CI from the Terraform outputs)"] = true
			} else {
				unpriced[instanceType+" in "+region] = true
			}
		}
		gp3, gp3Known := getGP3Rate(region)
		if !gp3Known {
			unpricedDisk[region] = true
		}
		ebsRate := (ebsGB * gp3) / 730.0
		hourlyRate := ec2Rate + ebsRate + publicIPv4HourlyRate
		ec2CostPerType["AWS EC2 Instances ("+instanceType+")"] += ec2Rate * 24.0
		ebsRunRate += ebsRate * 24.0

		// Disk and swap come from the node agent; without an answer they are unknown, not zero.
		diskTotal, diskUsed, swapTotal, swapUsed := 0, 0, 0, 0
		agentKnown := false
		if ip, ok := nodeAgentIPs[n.Name]; ok {
			if disk, err := fetchNodeDisk(ip); err != nil {
				log.Printf("collector: node agent on %s did not answer: %v", n.Name, err)
			} else {
				agentKnown = true
				diskTotal = int(disk.TotalBytes / (1024 * 1024))
				diskUsed = int(disk.UsedBytes / (1024 * 1024))
				swapTotal = int(disk.SwapTotalBytes / (1024 * 1024))
				swapUsed = int(disk.SwapUsedBytes / (1024 * 1024))
			}
		}

		h := &HostState{
			ID:             n.Name,
			Role:           nodeRole(n.Name),
			CreatedAt:      n.CreationTimestamp.Unix(),
			Schedulable:    schedulable,
			MetricsKnown:   metricsKnown,
			Region:         region,
			Type:           instanceType,
			Cores:          cpuCores,
			Threads:        1, // K8s reports vCPUs as cores.
			RamTotal:       ramTotal,
			RamAllocatable: ramAllocatable,
			RamUsed:        ramUsed,
			SwapTotal:      swapTotal,
			SwapUsed:       swapUsed,
			AgentKnown:     agentKnown,
			DiskTotal:      diskTotal,
			DiskUsed:       diskUsed,
			CpuUsed:        cpuUsed,
			Rate:           hourlyRate,
			PriceKnown:     priceKnown,
			EC2Rate:        ec2Rate,
			Capsules:       []CapsuleState{},
		}
		hostMap[n.Name] = h
	}

	for ns, pList := range nsPods {
		cap := CapsuleState{
			ID:    ns,
			Host:  getCapsuleDomain(ns, baseDomain),
			State: "ok",
			Ctr:   []ContainerState{},
			Vol:   []VolumeState{},
		}

		if pvcList, ok := nsPVCs[ns]; ok {
			for _, pvc := range pvcList {
				mib := 0
				if qty, ok := pvc.Status.Capacity[corev1.ResourceStorage]; ok {
					mib = int(qty.Value() / (1024 * 1024))
				} else if qty, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
					mib = int(qty.Value() / (1024 * 1024))
				}
				cap.Vol = append(cap.Vol, VolumeState{Name: pvc.Name, Mib: mib})
			}
		}

		var oldest time.Time
		nodeVotes := map[string]int{}
		kinds := map[string]string{}    // kind -> first reason seen
		since := map[string]time.Time{} // kind -> when the environment entered it
		live := 0
		for _, p := range pList {
			kind, reason, restarts := podCondition(p)
			cap.Restarts += restarts
			if kind == "done" || podIsDone(p, jobSucceeded) {
				continue
			}
			live++
			if _, seen := kinds[kind]; !seen || kinds[kind] == "" {
				kinds[kind] = reason
			}
			// Running since the last pod became ready; anything else since the first pod got there.
			if t := statusSince(p, kind); !t.IsZero() {
				prev, seen := since[kind]
				if !seen || (kind == "running" && t.After(prev)) || (kind != "running" && t.Before(prev)) {
					since[kind] = t
				}
			}
			if oldest.IsZero() || p.CreationTimestamp.Time.Before(oldest) {
				oldest = p.CreationTimestamp.Time
			}
			if p.Spec.NodeName != "" {
				nodeVotes[p.Spec.NodeName]++
			}
			for _, c := range p.Spec.Containers {
				u := podMetricsMap[p.Namespace+"/"+p.Name+"/"+c.Name]
				reqMib := int(c.Resources.Requests.Memory().Value() / (1024 * 1024))
				if reqMib == 0 {
					reqMib = 256
				}
				cap.ReqRam += reqMib
				cap.Ctr = append(cap.Ctr, ContainerState{
					Name: c.Name,
					Img:  strings.Split(c.Image, "@")[0],
					Ram:  u.Ram,
					Cpu:  u.Cpu,
				})
			}
		}
		if live == 0 {
			continue // only finished jobs left
		}
		for _, c := range cap.Ctr {
			cap.Ram += c.Ram
			cap.Cpu += c.Cpu
		}
		created := oldest
		if t, ok := nsCreated[ns]; ok && !t.IsZero() {
			created = t
		}
		if !created.IsZero() {
			cap.UpMin = int(now.Sub(created).Minutes())
		}

		// Worst first: a failing container outranks a pod still starting.
		kind := "running"
		switch {
		case hasKey(kinds, "degraded"):
			kind, cap.Status, cap.Reason = "degraded", "degraded", kinds["degraded"]
		case hasKey(kinds, "unschedulable"):
			kind, cap.Status, cap.Reason = "unschedulable", "waiting", kinds["unschedulable"]
		case hasKey(kinds, "deploying"):
			kind, cap.Status, cap.Reason = "deploying", "deploying", kinds["deploying"]
		default:
			cap.Status = "running"
		}
		statusFrom := since[kind]
		if statusFrom.IsZero() {
			statusFrom = oldest
		}
		if !statusFrom.IsZero() && now.After(statusFrom) {
			cap.StatusSec = int(now.Sub(statusFrom).Seconds())
		}

		// The node most of its pods run on; none at all means the scheduler could not place it.
		nodeName, best := "", 0
		for n, v := range nodeVotes {
			if v > best || (v == best && n < nodeName) {
				nodeName, best = n, v
			}
		}
		if nodeName == "" {
			data.Queue = append(data.Queue, cap)
		} else if h, ok := hostMap[nodeName]; ok {
			h.Capsules = append(h.Capsules, cap)
		}
	}

	// A promise is settled by the environment it was made for showing up on its node.
	settleReservations(hostMap)

	runRate := 0.0
	for _, h := range hostMap {
		h.PromisedMiB = reservedOn(h.ID, "")
		data.Hosts = append(data.Hosts, *h)
		runRate += h.Rate
	}

	// The server, which runs production, first; then the PR workers.
	sort.Slice(data.Hosts, func(i, j int) bool {
		if data.Hosts[i].Role != data.Hosts[j].Role {
			return data.Hosts[i].Role == "server"
		}
		return data.Hosts[i].ID < data.Hosts[j].ID
	})

	data.Fleet.NextEnvRequestMiB, data.Fleet.NextEnvBasis = nextEnvironmentMiB(&data)
	data.Fleet.NextEnvMiB = EffectiveMiB(data.Fleet.NextEnvRequestMiB)

	data.Fleet.SlotsUsed = len(data.Hosts)

	spendStats, err := getSpendStats(runRate, len(data.Hosts))
	if err != nil {
		log.Println("Error getting spend stats:", err)
	} else {
		data.Spend = spendStats
	}

	data.Spend.RunRate = runRate * 24.0

	data.Spend.Breakdown = map[string]float64{
		"AWS public IPv4 addresses": publicIPv4HourlyRate * 24.0 * float64(len(data.Hosts)),
		"AWS EBS volumes (gp3)":     ebsRunRate,
	}
	for k, v := range ec2CostPerType {
		data.Spend.Breakdown[k] = v
	}

	data.Spend.Notes = []string{"An estimate from on-demand prices: EC2 instances, their gp3 disks and public IPv4 addresses. " +
		"Traffic, snapshots, S3, the image registry and Cloudflare are not included, and minutes the dashboard was not running are not counted."}
	for _, what := range sortedKeys(unpriced) {
		data.Spend.Notes = append(data.Spend.Notes, fmt.Sprintf("No EC2 price for %s yet (the price feed has not loaded, or does not list it) - counted at $%.4f/h until it does, then corrected.", what, fallbackEC2HourlyRate))
	}
	for _, region := range sortedKeys(unpricedDisk) {
		data.Spend.Notes = append(data.Spend.Notes, fmt.Sprintf("No gp3 disk price for %s - counted at us-east-1's $0.08/GB-month.", region))
	}

	if sampleElapsed > 0 {
		for _, h := range data.Hosts {
			if err := recordHostSample(now, sampleElapsed, h); err != nil {
				log.Printf("collector: could not record the sample for %s: %v", h.ID, err)
			}
			for _, c := range h.Capsules {
				if err := recordCapsuleSample(now, c.ID, h.ID, c.Ram); err != nil {
					log.Printf("collector: could not record the sample for %s: %v", c.ID, err)
				}
			}
		}
	}

	// An environment's cost is its share of its node, sample by sample, since its namespace was created -
	// not the rate of the whole fleet, and not what an earlier environment of the same name ran up.
	since := map[string]time.Time{}
	missing := false
	for _, h := range data.Hosts {
		for _, c := range h.Capsules {
			if t, ok := nsCreated[c.ID]; ok {
				since[c.ID] = t
			} else {
				since[c.ID] = now.Add(-time.Duration(c.UpMin) * time.Minute)
			}
			if _, ok := costLifeCache[c.ID]; !ok {
				missing = true
			}
		}
	}
	if sampleElapsed > 0 || missing || now.Sub(costLifeAt) >= time.Minute {
		costLifeCache = getCapsulesCostLife(since)
		costLifeAt = now
		// One that could not be read waits for the next refresh too.
		for id := range since {
			if _, ok := costLifeCache[id]; !ok {
				costLifeCache[id] = 0
			}
		}
	}
	for i, h := range data.Hosts {
		for j, c := range h.Capsules {
			data.Hosts[i].Capsules[j].CostLife = costLifeCache[c.ID]
			data.Hosts[i].Capsules[j].RateH = h.Rate / float64(len(h.Capsules))
		}
	}

	data.GeneratedAt = time.Now().UnixMilli()
	return data, nil
}

// The domain the dashboard and PR environments sit under: the chart passes the generator's answer
// (utils/dashboardAccess.js hostParent), which never climbs above a zone such as co.uk; without it,
// the domain minus its first label.
func hostParent(domain string) string {
	if p := os.Getenv("FLAROPS_HOST_PARENT"); p != "" {
		return p
	}
	if parts := strings.Split(domain, "."); len(parts) > 2 {
		return strings.Join(parts[1:], ".")
	}
	return domain
}

func getCapsuleDomain(ns, baseDomain string) string {
	idx := strings.Index(ns, "-pr-")
	if idx != -1 {
		prSuffix := ns[idx+1:]
		parent := hostParent(baseDomain)
		if parent != baseDomain {
			return strings.Split(baseDomain, ".")[0] + "-" + prSuffix + "." + parent
		}
		return prSuffix + "." + baseDomain
	}
	idx = strings.Index(ns, "-production")
	if idx != -1 {
		return baseDomain
	}
	return ns + "." + baseDomain
}

// CapsuleTaint keeps everything but PR capsules off worker nodes; capsule pods tolerate it.
const CapsuleTaint = "flarops.io/capsule"

// Whether a capsule can be placed on the node: Ready, uncordoned, and without a NoSchedule or
// NoExecute taint other than the capsule taint, which capsules tolerate.
func schedulableForCapsules(n *corev1.Node) bool {
	ready := false
	for _, cond := range n.Status.Conditions {
		if cond.Type == corev1.NodeReady {
			ready = cond.Status == corev1.ConditionTrue
			break
		}
	}
	if !ready || n.Spec.Unschedulable {
		return false
	}
	for _, taint := range n.Spec.Taints {
		if taint.Key == CapsuleTaint {
			continue
		}
		if taint.Effect == corev1.TaintEffectNoSchedule || taint.Effect == corev1.TaintEffectNoExecute {
			return false
		}
	}
	return true
}

// "worker" for a machine added for PR environments (<instance>-worker-<slot>), otherwise "server".
func nodeRole(name string) string {
	if workerNodeName.MatchString(name) {
		return "worker"
	}
	return "server"
}

var workerNodeName = regexp.MustCompile(`-worker-\d+$`)

func hasKey(m map[string]string, k string) bool {
	_, ok := m[k]
	return ok
}

// Container waiting reasons that mean the pod will not come up without a change.
var stuckReasons = map[string]bool{
	"CrashLoopBackOff": true, "ImagePullBackOff": true, "ErrImagePull": true, "InvalidImageName": true,
	"CreateContainerConfigError": true, "CreateContainerError": true, "RunContainerError": true,
}

// What one pod says about its environment: "done" (a finished job), "degraded" (failing),
// "unschedulable" (the scheduler cannot place it), "deploying" (on its way up) or "running", with the
// reason to show and how often its containers restarted.
func podCondition(p *corev1.Pod) (string, string, int) {
	restarts := 0
	statuses := append(append([]corev1.ContainerStatus{}, p.Status.InitContainerStatuses...), p.Status.ContainerStatuses...)
	for _, cs := range p.Status.ContainerStatuses {
		restarts += int(cs.RestartCount)
	}
	switch p.Status.Phase {
	case corev1.PodSucceeded:
		return "done", "", restarts
	case corev1.PodFailed:
		reason := p.Status.Reason
		if reason == "" {
			reason = "failed"
		}
		return "degraded", p.Name + ": " + reason, restarts
	}
	for _, cs := range statuses {
		if cs.State.Waiting != nil && stuckReasons[cs.State.Waiting.Reason] {
			reason := cs.Name + ": " + cs.State.Waiting.Reason
			if cs.LastTerminationState.Terminated != nil && cs.LastTerminationState.Terminated.Reason != "" {
				reason += " (last exit: " + cs.LastTerminationState.Terminated.Reason + ")"
			}
			if cs.RestartCount > 0 {
				reason += fmt.Sprintf(" · %d restarts", cs.RestartCount)
			}
			return "degraded", reason, restarts
		}
	}
	if p.Status.Phase == corev1.PodPending {
		for _, cond := range p.Status.Conditions {
			if cond.Type == corev1.PodScheduled && cond.Status == corev1.ConditionFalse && cond.Reason == corev1.PodReasonUnschedulable {
				return "unschedulable", cond.Message, restarts
			}
		}
		for _, cs := range statuses {
			if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
				return "deploying", cs.Name + ": " + cs.State.Waiting.Reason, restarts
			}
		}
		return "deploying", "starting", restarts
	}
	for _, cs := range p.Status.ContainerStatuses {
		// Between crash-loop back-offs a container is briefly running or just exited, not waiting:
		// restarts with an abnormal last exit mean it is failing whatever its state this second.
		if !cs.Ready && cs.RestartCount > 0 && cs.LastTerminationState.Terminated != nil && cs.LastTerminationState.Terminated.ExitCode != 0 {
			last := cs.LastTerminationState.Terminated
			return "degraded", fmt.Sprintf("%s: exited with code %d (%s) · %d restarts", cs.Name, last.ExitCode, last.Reason, cs.RestartCount), restarts
		}
	}
	for _, cs := range p.Status.ContainerStatuses {
		if !cs.Ready {
			// A container gets a few minutes to pass its probes before "not ready" means trouble.
			if p.Status.StartTime != nil && time.Since(p.Status.StartTime.Time) < 5*time.Minute {
				return "deploying", cs.Name + ": starting", restarts
			}
			return "degraded", cs.Name + ": not ready", restarts
		}
	}
	return "running", "", restarts
}

// A pod that no longer says anything about its environment, whatever podCondition makes of it: one
// being deleted (a deploy replacing it), one evicted or failed under a controller that has already
// replaced it, or a failed attempt of a job that later succeeded.
func podIsDone(p *corev1.Pod, jobSucceeded map[string]time.Time) bool {
	if p.DeletionTimestamp != nil {
		return true
	}
	if p.Status.Phase != corev1.PodFailed {
		return false
	}
	if p.Status.Reason == "Evicted" {
		return true
	}
	for _, kind := range []string{"ReplicaSet", "StatefulSet", "DaemonSet"} {
		if ownerOfKind(p, kind) != "" {
			return true
		}
	}
	if job := ownerOfKind(p, "Job"); job != "" {
		if t, ok := jobSucceeded[p.Namespace+"/"+job]; ok && !t.Before(p.CreationTimestamp.Time) {
			return true
		}
	}
	return false
}

func ownerOfKind(p *corev1.Pod, kind string) string {
	for _, o := range p.OwnerReferences {
		if o.Kind == kind {
			return o.Name
		}
	}
	return ""
}

// When the pod entered what podCondition reports for it, zero if it does not say.
func statusSince(p *corev1.Pod, kind string) time.Time {
	switch kind {
	case "unschedulable":
		if t := conditionSince(p, corev1.PodScheduled, corev1.ConditionFalse); !t.IsZero() {
			return t
		}
	case "deploying":
		return p.CreationTimestamp.Time
	case "degraded":
		if t := conditionSince(p, corev1.PodReady, corev1.ConditionFalse); !t.IsZero() {
			return t
		}
		var first time.Time
		for _, cs := range p.Status.ContainerStatuses {
			for _, st := range []corev1.ContainerState{cs.State, cs.LastTerminationState} {
				if st.Terminated != nil && !st.Terminated.FinishedAt.IsZero() {
					if t := st.Terminated.FinishedAt.Time; first.IsZero() || t.Before(first) {
						first = t
					}
				}
			}
		}
		if !first.IsZero() {
			return first
		}
	case "running":
		if t := conditionSince(p, corev1.PodReady, corev1.ConditionTrue); !t.IsZero() {
			return t
		}
		var last time.Time
		for _, cs := range p.Status.ContainerStatuses {
			if cs.State.Running != nil && cs.State.Running.StartedAt.Time.After(last) {
				last = cs.State.Running.StartedAt.Time
			}
		}
		if !last.IsZero() {
			return last
		}
	}
	if p.Status.StartTime != nil {
		return p.Status.StartTime.Time
	}
	return p.CreationTimestamp.Time
}

func conditionSince(p *corev1.Pod, typ corev1.PodConditionType, status corev1.ConditionStatus) time.Time {
	for _, c := range p.Status.Conditions {
		if c.Type == typ && c.Status == status {
			return c.LastTransitionTime.Time
		}
	}
	return time.Time{}
}

func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

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

func startCollector(k8s *K8sClient) {
	var lastData []byte
	var lastSnapshot time.Time
	for {
		now := time.Now()
		shouldSnapshot := false
		if now.Sub(lastSnapshot) >= time.Minute {
			shouldSnapshot = true
			lastSnapshot = now
		}

		data, err := buildDashboardData(k8s, shouldSnapshot)
		if err != nil {
			log.Println("error building dashboard data:", err)
			if lastData != nil {
				hub.broadcast <- lastData
			}
		} else {
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

func buildDashboardData(k8s *K8sClient, shouldSnapshot bool) (DashboardData, error) {
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

	dashboardDomain := "dashboard." + baseDomain
	parts := strings.Split(baseDomain, ".")
	if len(parts) > 2 {
		dashboardDomain = "dashboard." + strings.Join(parts[1:], ".")
	}

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

	pvcs, _ := k8s.GetPVCs()
	nsPVCs := make(map[string][]*corev1.PersistentVolumeClaim)
	for _, pvc := range pvcs {
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
			unpriced[instanceType+" in "+region] = true
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
			PromisedMiB:    reservedOn(n.Name, ""),
			DiskTotal:      diskTotal,
			DiskUsed:       diskUsed,
			CpuUsed:        cpuUsed,
			Rate:           hourlyRate,
			PriceKnown:     priceKnown,
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
		kinds := map[string]string{} // kind -> first reason seen
		live := 0
		for _, p := range pList {
			kind, reason, restarts := podCondition(p)
			cap.Restarts += restarts
			if kind == "done" {
				continue
			}
			live++
			if _, seen := kinds[kind]; !seen || kinds[kind] == "" {
				kinds[kind] = reason
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
		if !oldest.IsZero() {
			cap.UpMin = int(time.Since(oldest).Minutes())
			cap.StatusSec = int(time.Since(oldest).Seconds())
		}

		// Worst first: a failing container outranks a pod still starting.
		switch {
		case hasKey(kinds, "degraded"):
			cap.Status, cap.Reason = "degraded", kinds["degraded"]
		case hasKey(kinds, "unschedulable"):
			cap.Status, cap.Reason = "waiting", kinds["unschedulable"]
		case hasKey(kinds, "deploying"):
			cap.Status, cap.Reason = "deploying", kinds["deploying"]
		default:
			cap.Status = "running"
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

	runRate := 0.0
	for _, h := range hostMap {
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
		data.Spend.Notes = append(data.Spend.Notes, fmt.Sprintf("No EC2 price for %s yet (the price feed has not loaded, or does not list it) - counted at $%.4f/h until it does.", what, fallbackEC2HourlyRate))
	}
	for _, region := range sortedKeys(unpricedDisk) {
		data.Spend.Notes = append(data.Spend.Notes, fmt.Sprintf("No gp3 disk price for %s - counted at us-east-1's $0.08/GB-month.", region))
	}

	if shouldSnapshot {
		nowTs := time.Now()
		for _, h := range data.Hosts {
			recordHostSample(nowTs, h.ID, h.Rate)
			for _, c := range h.Capsules {
				recordCapsuleSample(nowTs, c.ID, h.ID, c.Ram)
			}
		}
	}

	// An environment's cost is its share of its node, minute by minute, since its namespace was created -
	// not the rate of the whole fleet, and not what an earlier environment of the same name ran up.
	nsCreated, _ := k8s.GetNamespaceCreation()
	since := map[string]time.Time{}
	for _, h := range data.Hosts {
		for _, c := range h.Capsules {
			if t, ok := nsCreated[c.ID]; ok {
				since[c.ID] = t
			} else {
				since[c.ID] = time.Now().Add(-time.Duration(c.UpMin) * time.Minute)
			}
		}
	}
	capsulesCostLife := getCapsulesCostLife(since)
	for i, h := range data.Hosts {
		for j, c := range h.Capsules {
			data.Hosts[i].Capsules[j].CostLife = capsulesCostLife[c.ID]
			data.Hosts[i].Capsules[j].RateH = h.Rate / float64(len(h.Capsules))
		}
	}

	data.GeneratedAt = time.Now().UnixMilli()
	return data, nil
}

func getCapsuleDomain(ns, baseDomain string) string {
	idx := strings.Index(ns, "-pr-")
	if idx != -1 {
		prSuffix := ns[idx+1:]
		domainParts := strings.Split(baseDomain, ".")
		if len(domainParts) > 2 {
			subdomain := domainParts[0]
			rootDomain := strings.Join(domainParts[1:], ".")
			return subdomain + "-" + prSuffix + "." + rootDomain
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

func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

package main

import (
	"encoding/json"
	"log"
	"os"
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
	// No hardcoded fallback: the chart always passes DOMAIN, and inventing
	// someone else's domain here only produced capsule URLs that pointed at a
	// completely unrelated deployment.
	baseDomain := os.Getenv("DOMAIN")

	// Region, instance type and root volume size all come from the same values
	// the infrastructure was actually provisioned with (see
	// templates/dashboard.yaml.js) rather than from constants matching one
	// particular project.
	defaultRegion := os.Getenv("AWS_REGION")
	if defaultRegion == "" {
		defaultRegion = "us-west-2"
	}

	// Both of these describe the shape of the infrastructure, which is
	// declared exactly once in deploy/terraform/variables.tf and handed to the
	// chart from Terraform's own outputs at deploy time. Carrying a default
	// here would be a third copy of that fact, and the one nobody thinks to
	// update - so an empty value stays empty and the cost simply comes out
	// without that component, rather than confidently priced against a machine
	// nobody is running. It is only ever a fallback in the first place: a real
	// node reports its own type through the instance-type label below.
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
			Domain: dashboardDomain,
		},
		Hosts: []HostState{},
		Queue: []CapsuleState{},
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

	podMetricsMap := make(map[string]map[string]struct {
		Cpu int
		Ram int
	})
	for _, pm := range podMetrics {
		if _, ok := podMetricsMap[pm.Namespace]; !ok {
			podMetricsMap[pm.Namespace] = make(map[string]struct {
				Cpu int
				Ram int
			})
		}
		for _, cm := range pm.Containers {
			podMetricsMap[pm.Namespace][cm.Name] = struct {
				Cpu int
				Ram int
			}{
				Cpu: int(cm.Usage.Cpu().MilliValue() / 10), // approximate percentage of a core * 10? wait. 1 core = 1000m. CPU is in %. 1 core = 100%. So millicores / 10 = %.
				Ram: int(cm.Usage.Memory().Value() / (1024 * 1024)), // MiB
			}
		}
	}

	nsPods := make(map[string][]*corev1.Pod)
	for _, p := range pods {
		if p.Namespace == "kube-system" || p.Namespace == "default" || p.Namespace == "kube-public" || p.Namespace == "kube-node-lease" {
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
	for _, n := range nodes {
		ramTotal := int(n.Status.Capacity.Memory().Value() / (1024 * 1024))
		cpuCores := int(n.Status.Capacity.Cpu().Value())

		ramUsed := 0
		cpuUsed := 0
		for _, nm := range nodeMetrics {
			if nm.Name == n.Name {
				ramUsed = int(nm.Usage.Memory().Value() / (1024 * 1024))
				cpuUsed = int(nm.Usage.Cpu().MilliValue() / 10)
			}
		}

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
		ec2Rate := getEC2HourlyRate(instanceType, region)
		ebsRate := (ebsGB * 0.08) / 730.0
		eipRate := 0.005 / float64(len(nodes))
		hourlyRate := ec2Rate + ebsRate + eipRate

		diskTotal := 0
		diskUsed := 0
		if rawStats, err := k8s.GetNodeStatsSummary(n.Name); err == nil {
			var stats NodeStatsSummary
			if err := json.Unmarshal(rawStats, &stats); err == nil {
				diskTotal = int(stats.Node.Fs.CapacityBytes / (1024 * 1024))
				diskUsed = int(stats.Node.Fs.UsedBytes / (1024 * 1024))

			}
		}

		h := &HostState{
			ID:        n.Name,
			Region:    region,
			Type:      instanceType,
			Cores:     cpuCores,
			Threads:   1, // K8s reports vCPUs as cores.
			RamTotal:  ramTotal,
			RamUsed:   ramUsed,
			SwapTotal: 0,
			SwapUsed:  0,
			DiskTotal: diskTotal,
			DiskUsed:  diskUsed,
			CpuUsed:   cpuUsed,
			Rate:      hourlyRate,
			Capsules:  []CapsuleState{},
		}
		hostMap[n.Name] = h
	}

	for ns, pList := range nsPods {
		cap := CapsuleState{
			ID:        ns,
			Host:      getCapsuleDomain(ns, baseDomain),
			Status:    "running",
			StatusSec: 0,
			RateH:     0.0,
			CostLife:  0.0,
			State:     "ok",
			Ctr:       []ContainerState{},
			Vol:       []VolumeState{},
			ReqRam:    0,
		}

		if pvcList, ok := nsPVCs[ns]; ok {
			for _, pvc := range pvcList {
				mib := 0
				if qty, ok := pvc.Status.Capacity[corev1.ResourceStorage]; ok {
					mib = int(qty.Value() / (1024 * 1024))
				} else if qty, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
					mib = int(qty.Value() / (1024 * 1024))
				}
				cap.Vol = append(cap.Vol, VolumeState{
					Name: pvc.Name,
					Mib:  mib,
				})
			}
		}

		isPending := false
		nodeName := ""

		var oldest time.Time
		for _, p := range pList {
			if oldest.IsZero() || p.CreationTimestamp.Time.Before(oldest) {
				oldest = p.CreationTimestamp.Time
			}
			if p.Status.Phase == corev1.PodPending {
				isPending = true
				cap.Status = "waiting"
			}
			if p.Spec.NodeName != "" {
				nodeName = p.Spec.NodeName
			}

			// Add container info
			for _, c := range p.Spec.Containers {
				ram := 0
				cpu := 0
				if nsMap, ok := podMetricsMap[p.Namespace]; ok {
					if cm, ok := nsMap[c.Name]; ok {
						ram = cm.Ram
						cpu = cm.Cpu
					}
				}

				// parse resources requests
				reqMib := int(c.Resources.Requests.Memory().Value() / (1024 * 1024))
				if reqMib == 0 {
					// Fallback if not specified in requests
					reqMib = 256
				}
				cap.ReqRam += reqMib

				cap.Ctr = append(cap.Ctr, ContainerState{
					Name: c.Name,
					Img:  strings.Split(c.Image, "@")[0],
					Ram:  ram,
					Cpu:  cpu,
				})
			}
		}

		cap.Ram = 0
		cap.Cpu = 0
		for _, c := range cap.Ctr {
			cap.Ram += c.Ram
			cap.Cpu += c.Cpu
		}

		if !oldest.IsZero() {
			cap.UpMin = int(time.Since(oldest).Minutes())
			cap.StatusSec = int(time.Since(oldest).Seconds())
		}

		if isPending || nodeName == "" {
			data.Queue = append(data.Queue, cap)
		} else {
			if h, ok := hostMap[nodeName]; ok {
				h.Capsules = append(h.Capsules, cap)
			}
		}
	}

	// Read pending ConfigMaps from default namespace
	cms, err := k8s.GetConfigMaps("default")
	if err == nil {
		for _, cm := range cms {
			if strings.HasPrefix(cm.Name, "queue-") {
				ns := strings.TrimPrefix(cm.Name, "queue-")
				// Check if we already have it in Queue from pods
				alreadyInQueue := false
				for _, q := range data.Queue {
					if q.ID == ns {
						alreadyInQueue = true
						break
					}
				}
				if !alreadyInQueue {
					data.Queue = append(data.Queue, CapsuleState{
						ID:        ns,
						Host:      getCapsuleDomain(ns, baseDomain),
						Status:    "waiting",
						StatusSec: 0, // Could parse creation timestamp of ConfigMap
						State:     "ok",
						ReqRam:    655, // 655360Ki = ~655Mi
						Ctr:       []ContainerState{},
						Vol:       []VolumeState{},
					})
				}
			}
		}
	}

	runRate := 0.0
	ec2CostPerType := make(map[string]float64)
	ec2CountPerType := make(map[string]int)
	for _, h := range hostMap {
		data.Hosts = append(data.Hosts, *h)
		runRate += h.Rate
		ec2CostPerType["AWS EC2 Instances ("+h.Type+")"] += h.Rate * 24.0
		ec2CountPerType["AWS EC2 Instances ("+h.Type+")"]++
	}

	sort.Slice(data.Hosts, func(i, j int) bool {
		return data.Hosts[i].ID < data.Hosts[j].ID
	})

	data.Fleet.SlotsUsed = len(data.Hosts)
	data.Fleet.SlotsMax = len(data.Hosts) + 1

	// Add other AWS costs (EIP and EBS)
	eipCostPerHour := 0.005 // 1 EIP attached to server
	// Root volume size per host comes from FLAROPS_EBS_GB: (GB * 0.08) / 730 hours
	ebsCostPerHour := float64(len(data.Hosts)) * (ebsGB * 0.08) / 730.0
	
	// The runRate we accumulated from h.Rate ALREADY includes EC2 + EIP + EBS
	// We calculate Breakdown by subtracting what we know.
	eipRunRate := eipCostPerHour * 24.0
	ebsRunRate := ebsCostPerHour * 24.0

	// Get spend stats from DB
	spendStats, err := getSpendStats(runRate, len(data.Hosts))
	if err != nil {
		log.Println("Error getting spend stats:", err)
	} else {
		data.Spend = spendStats
	}

	data.Spend.RunRate = runRate * 24.0
	
	data.Spend.Breakdown = map[string]float64{
		"AWS Elastic IP":    eipRunRate,
		"AWS EBS Volumes":   ebsRunRate,
	}

	instancesEipRunRate := (eipRunRate / float64(len(data.Hosts)))
	instancesEbsRunRate := (ebsRunRate / float64(len(data.Hosts)))

	for k, v := range ec2CostPerType {
		count := float64(ec2CountPerType[k])
		data.Spend.Breakdown[k] = v - count*(instancesEipRunRate + instancesEbsRunRate)
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

	// Calculate CostLife for capsules
	capsulesCostLife := getCapsulesCostLife(runRate)
	for i, h := range data.Hosts {
		for j, c := range h.Capsules {
			if cl, ok := capsulesCostLife[c.ID]; ok {
				data.Hosts[i].Capsules[j].CostLife = cl
			}
			data.Hosts[i].Capsules[j].RateH = h.Rate / float64(len(h.Capsules))
		}
	}


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
        // fallback for main branch or unknown formats
        idx = strings.Index(ns, "-production")
        if idx != -1 {
                return baseDomain
        }
        return ns + "." + baseDomain
}

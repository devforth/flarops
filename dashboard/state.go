package main

type ContainerState struct {
	Name string `json:"n"`
	Img  string `json:"img"`
	Ram  int    `json:"ram"`
	Cpu  int    `json:"cpu"`
}

type VolumeState struct {
	Name string `json:"n"`
	Mib  int    `json:"mib"`
}

type CapsuleState struct {
	ID        string           `json:"id"`
	Host      string           `json:"host"`
	UpMin     int              `json:"upMin,omitempty"`
	Ram       int              `json:"ram"`
	Cpu       int              `json:"cpu"`
	Swap      int              `json:"swap,omitempty"`
	Status    string           `json:"status"`
	StatusSec int              `json:"statusSec"`
	RateH     float64          `json:"rateH,omitempty"`
	CostLife  float64          `json:"costLife,omitempty"`
	State     string           `json:"state,omitempty"`
	Ctr       []ContainerState `json:"ctr"`
	Vol       []VolumeState    `json:"vol"`
	ReqRam    int              `json:"reqRam,omitempty"`
}

type HostState struct {
	ID string `json:"id"`
	// Whether this node can actually take a new pod right now. A node that is
	// cordoned, NotReady, or tainted NoSchedule still reports its full
	// capacity, and once drained it reports almost no usage - which made it
	// look like the EMPTIEST node in the fleet and therefore the best target.
	Schedulable bool `json:"schedulable"`
	// False when metrics-server has no entry for this node. Usage then reads
	// as zero, which is indistinguishable from an idle node and equally
	// attractive to the placement logic - so it has to be tracked, not
	// guessed.
	MetricsKnown bool   `json:"metricsKnown"`
	Region       string `json:"region"`
	Type         string `json:"type"`
	Cores        int    `json:"cores"`
	Threads      int    `json:"threads"`
	RamTotal     int    `json:"ramTotal"`
	// What the kubelet will actually hand to pods: capacity minus
	// system-reserved, kube-reserved and the eviction threshold. On the nodes
	// Flarops provisions that is ~612Mi below capacity (256Mi + 256Mi set in
	// user_data, plus the default 100Mi hard eviction threshold). Planning
	// against capacity promised memory the scheduler will never give, and a
	// capsule placed into that gap pushes the node into eviction.
	RamAllocatable int            `json:"ramAllocatable"`
	RamUsed        int            `json:"ramUsed"`
	SwapTotal      int            `json:"swapTotal"`
	SwapUsed       int            `json:"swapUsed"`
	DiskTotal      int            `json:"diskTotal"`
	DiskUsed       int            `json:"diskUsed"`
	CpuUsed        int            `json:"cpuUsed"`
	Rate           float64        `json:"rate"`
	Capsules       []CapsuleState `json:"capsules"`
}

type FleetState struct {
	SlotsUsed int    `json:"slotsUsed"`
	SlotsMax  int    `json:"slotsMax"`
	Domain    string `json:"domain"`
}

type SpendState struct {
	Mtd        float64            `json:"mtd"`
	PrevSame   float64            `json:"prevSame"`
	RunRate    float64            `json:"runRate"`
	Projected  float64            `json:"projected"`
	MonthLabel string             `json:"monthLabel"`
	PrevLabel  string             `json:"prevLabel"`
	Days       []int              `json:"days"`
	Cur        []float64          `json:"cur"`
	Prev       []float64          `json:"prev"`
	DeltaPct   float64            `json:"deltaPct"`
	Breakdown  map[string]float64 `json:"breakdown"`
}

type DashboardData struct {
	Fleet FleetState     `json:"FLEET"`
	Hosts []HostState    `json:"HOSTS"`
	Queue []CapsuleState `json:"QUEUE"`
	Spend SpendState     `json:"SPEND"`
}

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

// Numbers are always sent, zero included: the page reads a missing one as undefined, which renders as NaN.
type CapsuleState struct {
	ID        string           `json:"id"`
	Host      string           `json:"host"`
	UpMin     int              `json:"upMin"`
	Ram       int              `json:"ram"`
	Cpu       int              `json:"cpu"`
	Swap      int              `json:"swap"`
	Status    string           `json:"status"`
	StatusSec int              `json:"statusSec"`
	RateH     float64          `json:"rateH"`
	CostLife  float64          `json:"costLife"`
	State     string           `json:"state,omitempty"`
	Ctr       []ContainerState `json:"ctr"`
	Vol       []VolumeState    `json:"vol"`
	ReqRam    int              `json:"reqRam"`
	// Why the environment is not simply running: a container's waiting reason, a failed job, or the
	// scheduler's message for a pod it cannot place.
	Reason   string `json:"reason,omitempty"`
	Restarts int    `json:"restarts"`
}

type HostState struct {
	ID string `json:"id"`
	// "server" or "worker" (a machine added for PR environments).
	Role string `json:"role"`
	// When the node joined (Unix seconds): a worker's age.
	CreatedAt int64 `json:"createdAt"`
	// Cordoned, NotReady or NoSchedule-tainted nodes still report full capacity. The capsule taint
	// on workers does not count: capsules tolerate it.
	Schedulable bool `json:"schedulable"`
	// Unmeasured reads as idle.
	MetricsKnown bool   `json:"metricsKnown"`
	Region       string `json:"region"`
	Type         string `json:"type"`
	Cores        int    `json:"cores"`
	Threads      int    `json:"threads"`
	RamTotal     int    `json:"ramTotal"`
	// Capacity minus system-reserved, kube-reserved and the eviction threshold.
	RamAllocatable int `json:"ramAllocatable"`
	RamUsed        int `json:"ramUsed"`
	SwapTotal      int `json:"swapTotal"`
	SwapUsed       int `json:"swapUsed"`
	// False when the node agent did not answer: disk and swap are then unknown, not empty.
	AgentKnown bool `json:"agentKnown"`
	// Memory the capacity oracle has promised to a PR environment that has not started yet.
	PromisedMiB int     `json:"promisedMiB"`
	DiskTotal   int     `json:"diskTotal"`
	DiskUsed    int     `json:"diskUsed"`
	CpuUsed     int     `json:"cpuUsed"`
	Rate        float64 `json:"rate"`
	// False when the EC2 price is the fallback, not the feed's price for this type and region.
	PriceKnown bool `json:"priceKnown"`
	// The EC2 part of Rate, kept with each sample so a fallback price can be corrected later.
	EC2Rate  float64        `json:"-"`
	Capsules []CapsuleState `json:"capsules"`
}

type FleetState struct {
	SlotsUsed int    `json:"slotsUsed"`
	Domain    string `json:"domain"`
	// The application's address and the project's name, for the header and the page title.
	AppDomain string `json:"appDomain"`
	Project   string `json:"project"`
	// The next PR environment as CI plans it: what production uses now (or, unmeasured, the largest
	// running environment), and that plus headroom - the one size the page, CI and the oracle use.
	NextEnvRequestMiB int    `json:"nextEnvRequestMiB"`
	NextEnvMiB        int    `json:"nextEnvMiB"`
	NextEnvBasis      string `json:"nextEnvBasis"`
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
	// What the figures leave out or had to assume, shown under them.
	Notes []string `json:"notes"`
}

type DashboardData struct {
	// When this frame was built (Unix ms): the page shows its age, so frozen data never reads as live.
	GeneratedAt int64          `json:"generatedAt"`
	Fleet       FleetState     `json:"FLEET"`
	Hosts       []HostState    `json:"HOSTS"`
	Queue       []CapsuleState `json:"QUEUE"`
	Spend       SpendState     `json:"SPEND"`
}

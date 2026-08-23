package doughengine

import "math"

const (
	K       = 2.4  // 0.3% × 8h anchor
	Q10     = 2.5
	saltRef = 2.5
	refTempC = 21.0
)

var surf = map[string]float64{
	"steel": 1.0,
	"stone": 0.8,
	"pan":   0.55,
	"rack":  0.3,
}

var frictionF = map[string]float64{
	"hand":      2,
	"mixer":     8,
	"processor": 14,
}

var typeMult = map[string]float64{
	"idy":   1.0,
	"ady":   1.33,
	"fresh": 3.0,
}

var typeGPerTsp = map[string]float64{
	"idy": 3.15,
	"ady": 3.1,
}

// Input mirrors the JS engine's input shape.
type Input struct {
	TempC       float64 `json:"tempC"`
	Hours       float64 `json:"hours"`
	Protein     float64 `json:"protein"`
	PlVal       float64 `json:"plVal"`
	Hydration   float64 `json:"hydration"`
	Salt        float64 `json:"salt"`
	OilPct      float64 `json:"oilPct"`
	SugarPct    float64 `json:"sugarPct"`
	Leavening   string  `json:"leavening"`
	YeastType   string  `json:"yeastType"`
	StarterStr  float64 `json:"starterStr"`
	Preferment  string  `json:"preferment"`
	RoomTemp    float64 `json:"roomTemp"`
	Ddt         float64 `json:"ddt"`
	MixMethod   string  `json:"mixMethod"`
	DoughWeight float64 `json:"doughWeight"`
	OvenC       float64 `json:"ovenC"`
	Surface     string  `json:"surface"`
}

// R holds ingredient weights and yeast amounts.
type R struct {
	Flour       float64  `json:"flour"`
	WaterG      float64  `json:"waterG"`
	SaltGrams   float64  `json:"saltGrams"`
	OilGrams    float64  `json:"oilGrams"`
	SugarGrams  float64  `json:"sugarGrams"`
	IdyPct      float64  `json:"idyPct"`
	Pct         float64  `json:"pct"`
	Grams       float64  `json:"grams"`
	Tsp         *float64 `json:"tsp"`
	LevainPct   float64  `json:"levainPct"`
	LevainGrams float64  `json:"levainGrams"`
}

// FP is the flour profile.
type FP struct {
	W        int     `json:"W"`
	HydrLo   int     `json:"hydrLo"`
	HydrHi   int     `json:"hydrHi"`
	MaxHours float64 `json:"maxHours"`
	Category string  `json:"category"`
}

// Rise holds the Gompertz rise model parameters.
type Rise struct {
	Arise    float64 `json:"Arise"`
	Lambda   float64 `json:"lambda"`
	MaxHours float64 `json:"maxHours"`
	Kd       float64 `json:"kd"`
	Mu       float64 `json:"mu"`
}

// Bake holds bake profile outputs.
type Bake struct {
	T       float64 `json:"t"`
	Colour  float64 `json:"colour"`
	Base    float64 `json:"base"`
	Leopard bool    `json:"leopard"`
	Acryl   bool    `json:"acryl"`
	Style   string  `json:"style"`
}

// Water holds water temperature.
type Water struct {
	Temp int `json:"temp"`
}

// Batch holds dough ball sizing.
type Batch struct {
	Balls int `json:"balls"`
	BallW int `json:"ballW"`
}

// Geometry holds crumb/pizza geometry factors.
type Geometry struct {
	Openness   float64 `json:"openness"`
	Strength   float64 `json:"strength"`
	SpringFrac float64 `json:"springFrac"`
	RimIndex   float64 `json:"rimIndex"`
}

// Verdicts holds tone strings for each verdict.
type Verdicts struct {
	Hydration string `json:"hydration"`
	Ferment   string `json:"ferment"`
	Digestion string `json:"digestion"`
	Bake      string `json:"bake"`
}

// Output is the full result of ComputeAll.
type Output struct {
	R        R        `json:"r"`
	FP       FP       `json:"fp"`
	Rise     Rise     `json:"rise"`
	Proof    float64  `json:"proof"`
	Bake     Bake     `json:"bake"`
	Digest   int      `json:"digest"`
	Water    Water    `json:"water"`
	Batch    Batch    `json:"batch"`
	Geometry Geometry `json:"geometry"`
	Verdicts Verdicts `json:"verdicts"`
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func flourProfile(protein, pl float64) FP {
	w := clamp(math.Round((protein-6)*40), 60, 400)
	var category string
	switch {
	case protein < 10.5:
		category = "Soft / weak"
	case protein < 12:
		category = "Medium"
	case protein < 13.5:
		category = "Strong (pizza)"
	default:
		category = "Very strong"
	}
	center := 55 + (protein-9)*2.833 + pl*2
	maxHours := clamp(6*math.Pow(2, (protein-9)/1.5), 8, 120)
	return FP{
		W:        int(w),
		HydrLo:   int(math.Round(center - 4)),
		HydrHi:   int(math.Round(center + 4)),
		MaxHours: maxHours,
		Category: category,
	}
}

func computeR(inp Input) R {
	rateFactor := math.Pow(Q10, (inp.TempC-refTempC)/10)
	saltRate := math.Exp(-0.12 * (inp.Salt - saltRef))
	flour := inp.DoughWeight / (1 + inp.Hydration/100 + inp.Salt/100 + inp.OilPct/100 + inp.SugarPct/100)
	r := R{
		Flour:      flour,
		WaterG:     flour * (inp.Hydration / 100),
		SaltGrams:  flour * (inp.Salt / 100),
		OilGrams:   flour * (inp.OilPct / 100),
		SugarGrams: flour * (inp.SugarPct / 100),
	}
	if inp.Leavening == "sourdough" {
		strength := 0.7 + (inp.StarterStr/100)*0.6
		levainPct := clamp(150/(inp.Hours*rateFactor*saltRate*strength), 3, 40)
		r.LevainPct = levainPct
		r.LevainGrams = flour * (levainPct / 100)
	} else {
		pfYeast := 1.0
		if inp.Preferment != "straight" {
			pfYeast = 0.85
		}
		idyPct := K / (inp.Hours * rateFactor * saltRate)
		pct := idyPct * typeMult[inp.YeastType] * pfYeast
		grams := flour * (pct / 100)
		r.IdyPct = idyPct
		r.Pct = pct
		r.Grams = grams
		if gPerTsp, ok := typeGPerTsp[inp.YeastType]; ok {
			tsp := grams / gPerTsp
			r.Tsp = &tsp
		}
	}
	return r
}

func riseModel(tempC, hours, protein float64) Rise {
	lagFrac := clamp(0.12+(25-tempC)*0.006, 0.08, 0.45)
	lambda := hours * lagFrac
	span := math.Max(hours-lambda, 0.5)
	arise := 90 + (protein-8)*8
	mu := (arise * 3.97) / (math.E * span)
	maxHours := clamp(6*math.Pow(2, (protein-9)/1.5), 8, 120)
	kd := clamp(2.0/maxHours, 0.01, 0.2)
	return Rise{Arise: arise, Lambda: lambda, MaxHours: maxHours, Kd: kd, Mu: mu}
}

func proofQualityFn(hours, maxHours float64) float64 {
	over := clamp((hours-maxHours)/maxHours, 0, 1.5)
	return clamp(1-over*0.6, 0.25, 1)
}

func bakeProfile(ovenC, hydration, salt, sugarPct, oilPct float64, surface string) Bake {
	k := surf[surface]
	t := 116 * math.Exp(-0.0098*ovenC)
	t *= 1 + (hydration-60)*0.004
	t *= 1.1 - 0.18*k
	t = clamp(t, 0.4, 30)
	top := 100 / (1 + math.Exp(-(ovenC-290)/48))
	top += (salt-saltRef)*4 + sugarPct*5 + oilPct*1.5
	top = clamp(top, 3, 100)
	base := clamp(top*(0.4+0.5*k)+k*22, 3, 100)
	var style string
	switch {
	case ovenC >= 430:
		style = "Neapolitan"
	case ovenC >= 340:
		style = "Artisan / high-heat"
	case ovenC >= 280:
		style = "New York"
	case ovenC >= 240:
		style = "Home oven"
	default:
		style = "Low / pan"
	}
	return Bake{
		T:       t,
		Colour:  top,
		Base:    base,
		Leopard: ovenC >= 425 && t <= 2.2,
		Acryl:   top >= 86 || base >= 90,
		Style:   style,
	}
}

func digestScore(hours, tempC float64, leavening, preferment string) int {
	d := 28 + 14*math.Log2(math.Max(hours, 2)/4)
	if leavening == "sourdough" {
		d += 22
	}
	if tempC <= 10 {
		d += 8
	}
	if preferment != "straight" {
		d += 8
	}
	return int(clamp(math.Round(d), 5, 99))
}

func waterTempFn(ddt, roomTemp float64, mixMethod, preferment string) Water {
	f := frictionF[mixMethod]
	nFactor := 3.0
	if preferment != "straight" {
		nFactor = 4.0
	}
	temp := clamp(math.Round(nFactor*ddt-(nFactor-1)*roomTemp-f), 0, 48)
	return Water{Temp: int(temp)}
}

func batchFn(doughWeight float64) Batch {
	balls := int(math.Max(1, math.Round(doughWeight/250)))
	ballW := int(math.Round(doughWeight / float64(balls)))
	return Batch{Balls: balls, BallW: ballW}
}

func geometryFn(hydration, protein, ovenC, proof, pl float64) Geometry {
	openness := clamp((hydration-50)/25, 0, 1)
	strength := clamp((protein-8)/7, 0, 1)
	springFrac := clamp((ovenC-230)/240, 0, 1)
	rimIndex := (20 + springFrac*80 + strength*24) * proof * (1 + pl*0.12)
	return Geometry{Openness: openness, Strength: strength, SpringFrac: springFrac, RimIndex: rimIndex}
}

func hydrationVerdict(hydration float64, fp FP) string {
	hi := float64(fp.HydrHi)
	lo := float64(fp.HydrLo)
	if hydration > hi+2 {
		return "bad"
	}
	if hydration > hi {
		return "warn"
	}
	if hydration < lo-2 {
		return "warn"
	}
	return "good"
}

func fermentVerdict(hours float64, fp FP) string {
	if hours > fp.MaxHours*1.25 {
		return "bad"
	}
	if hours > fp.MaxHours {
		return "warn"
	}
	return "good"
}

func digestVerdict(d int) string {
	if d >= 68 {
		return "good"
	}
	return "warn"
}

func bakeVerdict(b Bake, ovenC float64) string {
	if b.Leopard {
		return "good"
	}
	if ovenC >= 430 {
		return "warn"
	}
	if ovenC >= 280 {
		return "good"
	}
	if ovenC >= 240 {
		return "good"
	}
	return "warn"
}

// ComputeAll is the single pure entry point: inputs → every derived value.
func ComputeAll(inp Input) Output {
	pl := (inp.PlVal - 50) / 50
	r := computeR(inp)
	fp := flourProfile(inp.Protein, pl)
	rise := riseModel(inp.TempC, inp.Hours, inp.Protein)
	proof := proofQualityFn(inp.Hours, fp.MaxHours)
	bake := bakeProfile(inp.OvenC, inp.Hydration, inp.Salt, inp.SugarPct, inp.OilPct, inp.Surface)
	digest := digestScore(inp.Hours, inp.TempC, inp.Leavening, inp.Preferment)
	water := waterTempFn(inp.Ddt, inp.RoomTemp, inp.MixMethod, inp.Preferment)
	batch := batchFn(inp.DoughWeight)
	geometry := geometryFn(inp.Hydration, inp.Protein, inp.OvenC, proof, pl)
	verdicts := Verdicts{
		Hydration: hydrationVerdict(inp.Hydration, fp),
		Ferment:   fermentVerdict(inp.Hours, fp),
		Digestion: digestVerdict(digest),
		Bake:      bakeVerdict(bake, inp.OvenC),
	}
	return Output{R: r, FP: fp, Rise: rise, Proof: proof, Bake: bake, Digest: digest, Water: water, Batch: batch, Geometry: geometry, Verdicts: verdicts}
}

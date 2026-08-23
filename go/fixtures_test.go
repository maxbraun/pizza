package doughengine

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

// fixtureOutput matches the snapshot shape written by gen-fixtures.js.
type fixtureOutput struct {
	R struct {
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
	} `json:"r"`
	FP struct {
		W        int     `json:"W"`
		HydrLo   int     `json:"hydrLo"`
		HydrHi   int     `json:"hydrHi"`
		MaxHours float64 `json:"maxHours"`
		Category string  `json:"category"`
	} `json:"fp"`
	Rise struct {
		Arise    float64 `json:"Arise"`
		Lambda   float64 `json:"lambda"`
		MaxHours float64 `json:"maxHours"`
		Kd       float64 `json:"kd"`
		Mu       float64 `json:"mu"`
	} `json:"rise"`
	Proof  float64 `json:"proof"`
	Bake   struct {
		T       float64 `json:"t"`
		Colour  float64 `json:"colour"`
		Base    float64 `json:"base"`
		Leopard bool    `json:"leopard"`
		Acryl   bool    `json:"acryl"`
		Style   string  `json:"style"`
	} `json:"bake"`
	Digest   int `json:"digest"`
	Water    struct {
		Temp int `json:"temp"`
	} `json:"water"`
	Batch struct {
		Balls int `json:"balls"`
		BallW int `json:"ballW"`
	} `json:"batch"`
	Geometry struct {
		Openness   float64 `json:"openness"`
		Strength   float64 `json:"strength"`
		SpringFrac float64 `json:"springFrac"`
		RimIndex   float64 `json:"rimIndex"`
	} `json:"geometry"`
	Verdicts struct {
		Hydration string `json:"hydration"`
		Ferment   string `json:"ferment"`
		Digestion string `json:"digestion"`
		Bake      string `json:"bake"`
	} `json:"verdicts"`
}

type fixture struct {
	Name   string        `json:"name"`
	Input  Input         `json:"input"`
	Output fixtureOutput `json:"output"`
}

func TestFixtures(t *testing.T) {
	data, err := os.ReadFile("../fixtures.json")
	if err != nil {
		t.Fatalf("fixtures.json not found — run: node gen-fixtures.js from the repo root: %v", err)
	}
	var fixtures []fixture
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}

	for _, f := range fixtures {
		f := f
		t.Run(f.Name, func(t *testing.T) {
			got := ComputeAll(f.Input)
			want := f.Output

			approx := func(field string, got, want float64) {
				t.Helper()
				if diff := math.Abs(got - want); diff > 1e-9 {
					t.Errorf("%s: got %.15g, want %.15g (diff %g)", field, got, want, diff)
				}
			}
			eq := func(field string, got, want interface{}) {
				t.Helper()
				if got != want {
					t.Errorf("%s: got %v, want %v", field, got, want)
				}
			}
			nullableApprox := func(field string, got *float64, want *float64) {
				t.Helper()
				if (got == nil) != (want == nil) {
					t.Errorf("%s: nil mismatch — got %v, want %v", field, got, want)
					return
				}
				if got != nil {
					approx(field, *got, *want)
				}
			}

			approx("r.flour",       got.R.Flour,       want.R.Flour)
			approx("r.waterG",      got.R.WaterG,      want.R.WaterG)
			approx("r.saltGrams",   got.R.SaltGrams,   want.R.SaltGrams)
			approx("r.oilGrams",    got.R.OilGrams,    want.R.OilGrams)
			approx("r.sugarGrams",  got.R.SugarGrams,  want.R.SugarGrams)
			approx("r.idyPct",      got.R.IdyPct,      want.R.IdyPct)
			approx("r.pct",         got.R.Pct,         want.R.Pct)
			approx("r.grams",       got.R.Grams,       want.R.Grams)
			nullableApprox("r.tsp", got.R.Tsp,         want.R.Tsp)
			approx("r.levainPct",   got.R.LevainPct,   want.R.LevainPct)
			approx("r.levainGrams", got.R.LevainGrams, want.R.LevainGrams)

			eq("fp.W",        got.FP.W,        want.FP.W)
			eq("fp.hydrLo",   got.FP.HydrLo,   want.FP.HydrLo)
			eq("fp.hydrHi",   got.FP.HydrHi,   want.FP.HydrHi)
			approx("fp.maxHours", got.FP.MaxHours, want.FP.MaxHours)
			eq("fp.category", got.FP.Category,  want.FP.Category)

			approx("rise.Arise",    got.Rise.Arise,    want.Rise.Arise)
			approx("rise.lambda",   got.Rise.Lambda,   want.Rise.Lambda)
			approx("rise.maxHours", got.Rise.MaxHours, want.Rise.MaxHours)
			approx("rise.kd",       got.Rise.Kd,       want.Rise.Kd)
			approx("rise.mu",       got.Rise.Mu,       want.Rise.Mu)

			approx("proof", got.Proof, want.Proof)

			approx("bake.t",      got.Bake.T,      want.Bake.T)
			approx("bake.colour", got.Bake.Colour, want.Bake.Colour)
			approx("bake.base",   got.Bake.Base,   want.Bake.Base)
			eq("bake.leopard",    got.Bake.Leopard, want.Bake.Leopard)
			eq("bake.acryl",      got.Bake.Acryl,   want.Bake.Acryl)
			eq("bake.style",      got.Bake.Style,   want.Bake.Style)

			eq("digest",      got.Digest,     want.Digest)
			eq("water.temp",  got.Water.Temp, want.Water.Temp)
			eq("batch.balls", got.Batch.Balls, want.Batch.Balls)
			eq("batch.ballW", got.Batch.BallW, want.Batch.BallW)

			approx("geometry.openness",   got.Geometry.Openness,   want.Geometry.Openness)
			approx("geometry.strength",   got.Geometry.Strength,   want.Geometry.Strength)
			approx("geometry.springFrac", got.Geometry.SpringFrac, want.Geometry.SpringFrac)
			approx("geometry.rimIndex",   got.Geometry.RimIndex,   want.Geometry.RimIndex)

			eq("verdicts.hydration", got.Verdicts.Hydration, want.Verdicts.Hydration)
			eq("verdicts.ferment",   got.Verdicts.Ferment,   want.Verdicts.Ferment)
			eq("verdicts.digestion", got.Verdicts.Digestion, want.Verdicts.Digestion)
			eq("verdicts.bake",      got.Verdicts.Bake,      want.Verdicts.Bake)
		})
	}
}

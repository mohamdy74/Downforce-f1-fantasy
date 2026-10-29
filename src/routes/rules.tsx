import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/rules")({
  head: () => ({
    meta: [
      { title: "Scoring rules — DOWNFORCE" },
      {
        name: "description",
        content:
          "How DOWNFORCE scoring works: top 10 accuracy points, pole, fastest lap, DNF, perfect weekend bonuses and penalties.",
      },
      { property: "og:title", content: "Scoring rules — DOWNFORCE" },
      {
        property: "og:description",
        content: "Top 10 accuracy, bonus picks, perfect weekend and the no-submission penalty.",
      },
      { name: "twitter:title", content: "Scoring rules — DOWNFORCE" },
      {
        name: "twitter:description",
        content: "Top 10 accuracy, bonus picks, perfect weekend and the no-submission penalty.",
      },
    ],
  }),
  component: Rules,
});

const positionRows = [
  ["Exact position", "+3"],
  ["1 position off", "+2"],
  ["2 positions off", "+1"],
  ["3 positions off", "−1"],
  ["4 positions off", "−2"],
  ["5 or more off", "−3"],
];

const bonusRows = [
  ["Pole position", "+3"],
  ["Fastest lap", "+3"],
  ["DNF pick", "+1"],
  ["Perfect top 10", "+10"],
  ["Perfect weekend (total bonus)", "+15"],
  ["No predictions submitted", "−25"],
];

const sprintRows = [
  ["Exact position in the sprint top 8", "+1 each"],
  ["Sprint pole position", "+1"],
  ["Any other position", "0"],
  ["Maximum per sprint", "9"],
  ["No sprint picks submitted", "0 (no penalty)"],
];

function Rules() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl">Scoring rules</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Each Grand Prix you predict the top 10 finishing order plus three bonus picks. Points are
        awarded after the chequered flag.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <RuleTable title="Top 10 accuracy" rows={positionRows} />
        <RuleTable title="Bonuses & penalty" rows={bonusRows} />
      </div>

      <div className="carbon-panel mt-6 rounded-lg p-5">
        <h2 className="text-lg">Lock deadlines</h2>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li>Pole position pick closes when qualifying starts.</li>
          <li>Top 10, fastest lap and DNF picks close when the race starts.</li>
          <li>Locking is automatic — late or missing picks are not accepted.</li>
        </ul>
      </div>

      <div className="carbon-panel mt-6 rounded-lg p-5">
        <h2 className="text-lg">Max points per weekend</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          30 from a perfect top 10, 3 for pole, 3 for fastest lap, 1 for a DNF and 15 for a perfect
          weekend — 52 in total.
        </p>
      </div>

      <div className="mt-10">
        <h2 className="text-2xl">Sprint weekends</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          On sprint weekends a Sprint tab appears. You predict the first 8 sprint positions (a
          position only scores when it is exactly right) plus the sprint pole. Sprint points are
          added to that round's total.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <RuleTable title="Sprint points" rows={sprintRows} />
          <div className="carbon-panel rounded-lg p-5">
            <h2 className="text-lg">Sprint lock deadlines</h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>Sprint pole pick closes when sprint qualifying starts.</li>
              <li>Sprint top 8 picks close when the sprint starts.</li>
              <li>The sprint pole is a separate pick, saved on its own.</li>
            </ul>
          </div>
        </div>
      </div>
    </main>
  );
}

function RuleTable({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <div className="carbon-panel rounded-lg p-5">
      <h2 className="text-lg">{title}</h2>
      <dl className="mt-3 divide-y divide-border">
        {rows.map(([label, points]) => (
          <div key={label} className="flex items-center justify-between py-2">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="font-mono text-sm font-bold">{points}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

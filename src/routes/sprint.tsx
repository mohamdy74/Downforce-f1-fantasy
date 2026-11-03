import { createFileRoute } from "@tanstack/react-router";

import { SprintContent } from "@/components/SprintPredict";

export const Route = createFileRoute("/sprint")({
  staticData: { sitemap: false },
  head: () => ({
    meta: [
      { title: "Sprint picks — DOWNFORCE" },
      {
        name: "description",
        content:
          "Predict the sprint top 8 and the sprint pole. Up to 9 extra points on sprint weekends.",
      },
      { property: "og:title", content: "Sprint picks — DOWNFORCE" },
      {
        property: "og:description",
        content: "Predict the sprint top 8 and the sprint pole.",
      },
      { name: "twitter:title", content: "Sprint picks — DOWNFORCE" },
      { name: "twitter:description", content: "Predict the sprint top 8 and the sprint pole." },
    ],
  }),
  component: Sprint,
});

function Sprint() {
  return (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-10">
      <SprintContent />
    </main>
  );
}

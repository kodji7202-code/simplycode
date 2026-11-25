import type { Team, WorkflowRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  draftToPipelineUpsertInput,
  draftToTeamUpsertInput,
  newPipelineDraft,
  pipelineRuns,
  pipelineToDraft,
  slugifyStageId,
  stageChainLabel,
  teamToDraft,
} from "./teamsPipelines.logic";

const team = {
  id: "build",
  name: "Build",
  leadBotId: "planner",
  memberBotIds: ["dev", "reviewer"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as Team;

describe("slugifyStageId", () => {
  it("slugs a name and dedupes against taken ids", () => {
    expect(slugifyStageId("Ship It!", new Set())).toBe("ship-it");
    expect(slugifyStageId("ship it", new Set(["ship-it"]))).toBe("ship-it-2");
    expect(slugifyStageId("ship it", new Set(["ship-it", "ship-it-2"]))).toBe("ship-it-3");
  });

  it("falls back to stage for a name without slug characters", () => {
    expect(slugifyStageId("---", new Set())).toBe("stage");
  });
});

describe("draftToTeamUpsertInput", () => {
  it("sends members and optional fields, omitting empties", () => {
    expect(draftToTeamUpsertInput({ ...teamToDraft(team), name: " Build " })).toStrictEqual({
      id: "build",
      name: "Build",
      leadBotId: "planner",
      memberBotIds: ["dev", "reviewer"],
    });
  });

  it("is null without a name", () => {
    expect(draftToTeamUpsertInput({ ...teamToDraft(team), name: "  " })).toBeNull();
  });
});

describe("draftToPipelineUpsertInput", () => {
  const draft = newPipelineDraft("build" as Team["id"]);

  it("sends stages with ids kept, onFail only on review stages", () => {
    const input = draftToPipelineUpsertInput({
      ...draft,
      name: "Ship",
      stages: [
        { id: "dev", name: "Dev", botId: "dev", kind: "work", instructions: "Do it.", onFail: "" },
        {
          id: "review",
          name: "Review",
          botId: "reviewer",
          kind: "review",
          instructions: "Check.",
          onFail: "dev",
        },
      ],
      maxRounds: "4",
      stageTimeoutMinutes: "30",
    });
    expect(input).toStrictEqual({
      teamId: "build",
      name: "Ship",
      stages: [
        { id: "dev", name: "Dev", botId: "dev", kind: "work", instructions: "Do it." },
        {
          id: "review",
          name: "Review",
          botId: "reviewer",
          kind: "review",
          instructions: "Check.",
          onFail: "dev",
        },
      ],
      limits: { maxRounds: 4, stageTimeoutMinutes: 30 },
    });
  });

  it("is null with an empty name, no stages, or an unfilled stage", () => {
    expect(draftToPipelineUpsertInput({ ...draft, name: "" })).toBeNull();
    expect(draftToPipelineUpsertInput({ ...draft, name: "x", stages: [] })).toBeNull();
    expect(
      draftToPipelineUpsertInput({
        ...draft,
        name: "x",
        stages: [{ id: "a", name: "", botId: "dev", kind: "work", instructions: "y", onFail: "" }],
      }),
    ).toBeNull();
  });

  it("keeps stored limits on update when the fields do not parse", () => {
    const input = draftToPipelineUpsertInput({
      ...draft,
      name: "x",
      stages: [{ id: "a", name: "A", botId: "dev", kind: "work", instructions: "y", onFail: "" }],
      maxRounds: "",
      stageTimeoutMinutes: "abc",
    });
    expect(input !== null && "limits" in input).toBe(false);
  });
});

describe("pipelineToDraft", () => {
  it("round-trips stages and limits", () => {
    const back = draftToPipelineUpsertInput(
      pipelineToDraft({
        id: "ship",
        teamId: "build",
        name: "Ship",
        stages: [
          {
            id: "dev",
            name: "Dev",
            botId: "dev",
            kind: "work",
            instructions: "Do it.",
          },
        ],
        limits: { maxRounds: 2, stageTimeoutMinutes: 15 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as never),
    );
    expect(back?.limits).toStrictEqual({ maxRounds: 2, stageTimeoutMinutes: 15 });
  });
});

describe("pipelineRuns", () => {
  const run = (key: string | null): WorkflowRun => ({ key }) as WorkflowRun;
  it("keeps only runs started under the pipeline's key prefix", () => {
    const runs = [
      run("pipeline:ship:abc"),
      run("pipeline:ship-2:abc"),
      run("other:ship:abc"),
      run(null),
      run("pipeline:ship:def"),
    ];
    expect(pipelineRuns(runs, "ship").map((entry) => entry.key)).toStrictEqual([
      "pipeline:ship:abc",
      "pipeline:ship:def",
    ]);
  });
});

describe("stageChainLabel", () => {
  it("joins stage names", () => {
    expect(
      stageChainLabel({
        stages: [{ name: "Dev" }, { name: "Review" }] as never,
      }),
    ).toBe("Dev → Review");
  });
});

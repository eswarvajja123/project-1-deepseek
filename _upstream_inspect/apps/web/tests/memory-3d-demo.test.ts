import { describe, expect, it } from "vitest";
import { buildDemoOverview, isDemoGraphSize, DEMO_GRAPH_LIMITS, DEMO_MAX_NODES } from "../src/features/memory-workspace/memory-3d-demo.js";

describe("demo mode", () => {
  it("exposes exactly the benchmark sizes the plan asks for", () => {
    expect(DEMO_GRAPH_LIMITS.map(size => size.label)).toEqual(["2k", "10k", "50k"]);
    expect(isDemoGraphSize("50k")).toBe(true);
    expect(isDemoGraphSize("live")).toBe(false);
  });

  it("builds a payload the overview contract accepts", () => {
    const { data } = buildDemoOverview("2k");
    expect(data.nodes).toHaveLength(2000);
    expect(data.edges).toHaveLength(6000);
    expect(data.summary.nodeCount).toBe(2000);
    expect(data.truncated).toBe(false);
    expect(data.totalMatchingNodes).toBe(2000);
    // The UI relies on these being present and honest for the counter row.
    expect(data.summary.recordCount).toBe(data.nodes.filter(node => node.type === "MEMORY").length);
    expect(data.summary.sourceCount).toBeLessThanOrEqual(24);
  });

  it("cannot exceed the server's 50,000-node ceiling", () => {
    const { data } = buildDemoOverview("50k");
    expect(data.nodes).toHaveLength(DEMO_MAX_NODES);
    expect(data.edges).toHaveLength(150000);
  });

  it("is reproducible, so the same size yields the same graph", () => {
    const first = buildDemoOverview("2k").data;
    const second = buildDemoOverview("2k").data;
    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
  });

  it("maps a numeric limit to the smallest covering demo size", () => {
    expect(buildDemoOverview(1500).data.nodes).toHaveLength(2000);
    expect(buildDemoOverview(9000).data.nodes).toHaveLength(10000);
    // A limit beyond the largest size clamps to it rather than throwing.
    expect(buildDemoOverview(999_999).data.nodes).toHaveLength(DEMO_MAX_NODES);
  });
});

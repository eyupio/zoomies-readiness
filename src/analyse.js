import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const githubHosted =
  /^(ubuntu|windows|macos)-(latest|[0-9][a-z0-9.-]*)(-arm)?$/i;
const managedVendors = [
  "blacksmith",
  "buildjet",
  "depot",
  "namespace",
  "nscloud",
  "runs-on",
  "ubicloud",
  "warp",
];

function listWorkflowFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function exactMatrixKey(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/);
  return match ? match[1] : null;
}

function staticMatrixValues(job, key) {
  const value = job?.strategy?.matrix?.[key];
  if (!Array.isArray(value)) return null;
  const values = value.filter(
    (item) => typeof item === "string" && !item.includes("${{"),
  );
  return values.length === value.length && values.length > 0 ? values : null;
}

function conditionalTargets(value) {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^\$\{\{[\s\S]*&&\s*(['"])([^'"]+)\1\s*\|\|\s*(['"])([^'"]+)\3\s*\}\}$/,
  );
  if (!match) return null;
  const candidates = [match[2], match[4]];
  return candidates.every(
    (candidate) =>
      isManaged(candidate) ||
      candidate.toLowerCase() === "zoomies" ||
      candidate.toLowerCase().startsWith("zoomies-"),
  )
    ? candidates
    : null;
}

function resolveTargets(value, job) {
  const source = Array.isArray(value) ? value : [value];
  let targets = [[]];

  for (const item of source) {
    if (typeof item !== "string") {
      return {
        dynamic: true,
        targets: [],
        reason: "runs-on is not a string or string list",
      };
    }
    const matrixKey = exactMatrixKey(item);
    if (matrixKey) {
      const values = staticMatrixValues(job, matrixKey);
      if (!values) {
        return {
          dynamic: true,
          targets: [],
          reason: `matrix.${matrixKey} is computed or has no static string values`,
        };
      }
      targets = targets.flatMap((target) =>
        values.map((matrixValue) => [...target, matrixValue]),
      );
      continue;
    }
    if (item.includes("${{")) {
      const alternatives = conditionalTargets(item);
      if (alternatives) {
        targets = targets.flatMap((target) =>
          alternatives.map((alternative) => [...target, alternative]),
        );
        continue;
      }
      return {
        dynamic: true,
        targets: [],
        reason: "runs-on contains a dynamic expression",
      };
    }
    targets = targets.map((target) => [...target, item]);
  }

  return { dynamic: false, targets };
}

function isManaged(label) {
  const normal = label.toLowerCase();
  return (
    githubHosted.test(normal) ||
    managedVendors.some((vendor) => normal.includes(vendor))
  );
}

function platform(label) {
  const normal = label.toLowerCase();
  let os = "";
  if (/ubuntu|linux|debian/.test(normal)) os = "linux";
  else if (/windows/.test(normal)) os = "windows";
  else if (/macos|darwin/.test(normal)) os = "macos";

  let arch = /arm64|aarch64|-arm(?:-|$)/.test(normal) ? "arm64" : "x64";
  // GitHub-hosted macos-14 and newer default to Apple Silicon hardware, so an
  // unqualified label like "macos-14" is arm64 even though it carries no arch
  // suffix. The "-large" variants are the one exception: they stay Intel x64.
  if (
    os === "macos" &&
    /^macos-(1[4-9]|[2-9][0-9])(?:$|-)/.test(normal) &&
    !normal.includes("large")
  ) {
    arch = "arm64";
  }
  return { os, arch };
}

function needsDocker(job) {
  if (job.container || (job.services && Object.keys(job.services).length > 0))
    return true;
  return (job.steps || []).some((step) => {
    if (
      typeof step?.uses === "string" &&
      step.uses.toLowerCase().startsWith("docker/")
    )
      return true;
    return (
      typeof step?.run === "string" && /(^|\s)docker(?:\s|$)/m.test(step.run)
    );
  });
}

function classifyTarget(labels, pools) {
  const clean = labels.map((label) => label.trim()).filter(Boolean);
  const lower = clean.map((label) => label.toLowerCase());
  const rendered = clean.length === 1 ? clean[0] : `[${clean.join(", ")}]`;

  if (
    lower.some((label) => label === "zoomies" || label.startsWith("zoomies-"))
  ) {
    return {
      status: "already",
      target: rendered,
      suggestion: rendered,
      reason: "already targets Zoomies",
    };
  }

  const managed = clean.find(isManaged);
  if (!managed) {
    if (lower.includes("self-hosted") || clean.length > 0) {
      return {
        status: "reusable",
        target: rendered,
        suggestion: rendered,
        reason:
          "reuse these labels on a Zoomies pool; no workflow edit is required",
      };
    }
    return {
      status: "review",
      target: rendered,
      suggestion: "",
      reason: "runs-on has no usable labels",
    };
  }

  const described = platform(managed);
  if (!described.os) {
    return {
      status: "review",
      target: rendered,
      suggestion: "",
      reason:
        "managed runner label found, but its platform cannot be inferred safely",
    };
  }
  if (described.os !== "linux") {
    return {
      status: "unsupported",
      target: rendered,
      suggestion: "",
      reason: `${described.os}/${described.arch} has no first-party Zoomies runner image yet`,
    };
  }

  return {
    status: "ready",
    target: rendered,
    suggestion: described.arch === "arm64" ? pools.arm64 : pools.x64,
    reason: `${described.os}/${described.arch} maps cleanly to a Zoomies pool`,
  };
}

function combineTargets(classifications) {
  const priority = ["unsupported", "review", "ready", "reusable", "already"];
  const status = priority.find((candidate) =>
    classifications.some((item) => item.status === candidate),
  );
  return {
    status,
    target: classifications.map((item) => item.target).join(" · "),
    suggestion: [
      ...new Set(
        classifications.map((item) => item.suggestion).filter(Boolean),
      ),
    ].join(" or "),
    reason: [...new Set(classifications.map((item) => item.reason))].join("; "),
  };
}

function analyseWorkflow(file, root, pools) {
  const relativePath = path.relative(root, file).split(path.sep).join("/");
  let workflow;
  try {
    workflow = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return {
      path: relativePath,
      error: error.message,
      jobs: [],
    };
  }

  const jobs = [];
  for (const [jobName, job] of Object.entries(workflow?.jobs || {})) {
    if (!job || typeof job !== "object" || !("runs-on" in job)) continue;
    const resolved = resolveTargets(job["runs-on"], job);
    let assessment;
    if (resolved.dynamic) {
      assessment = {
        status: "review",
        target: String(job["runs-on"]),
        suggestion: "",
        reason: resolved.reason,
      };
    } else {
      assessment = combineTargets(
        resolved.targets.map((target) => classifyTarget(target, pools)),
      );
    }
    jobs.push({
      workflow: relativePath,
      job: jobName,
      ...assessment,
      needs_docker: needsDocker(job),
    });
  }
  return { path: relativePath, jobs };
}

function analyseRepository(directory, pools) {
  const workflows = listWorkflowFiles(directory).map((file) =>
    analyseWorkflow(file, directory, pools),
  );
  const jobs = workflows.flatMap((workflow) => workflow.jobs);
  const parseErrors = workflows
    .filter((workflow) => workflow.error)
    .map(({ path: file, error }) => ({ file, error }));
  const counts = {
    total: jobs.length,
    ready: jobs.filter((job) => job.status === "ready").length,
    reusable: jobs.filter((job) => job.status === "reusable").length,
    already: jobs.filter((job) => job.status === "already").length,
    review: jobs.filter((job) => job.status === "review").length,
    unsupported: jobs.filter((job) => job.status === "unsupported").length,
    docker: jobs.filter((job) => job.needs_docker).length,
  };
  const favourable = counts.ready + counts.reusable + counts.already;
  const score =
    counts.total === 0 ? 0 : Math.round((favourable / counts.total) * 100);
  return {
    version: 1,
    score,
    counts,
    parse_errors: parseErrors,
    workflows,
    jobs,
  };
}

export {
  analyseRepository,
  classifyTarget,
  conditionalTargets,
  needsDocker,
  platform,
  resolveTargets,
};

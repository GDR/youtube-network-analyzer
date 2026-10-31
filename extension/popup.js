let currentState = { records: [], playerEvents: [], inFlight: [] };

function badgeForOutcome(outcome) {
  switch (outcome) {
    case "OK_PRIMARY":
      return `<span class="badge b-ok">OK_PRIMARY</span>`;
    case "OK_FALLBACK":
      return `<span class="badge b-fallback">OK_FALLBACK</span>`;
    case "STALL_5S_TIMEOUT":
    case "SLOW_TTFB_STALL":
    case "SLOW_CHUNK_TRANSFER":
    case "NETWORK_ERROR":
      return `<span class="badge b-stall">${outcome}</span>`;
    case "FAST_REJECT_ROUTE":
      return `<span class="badge b-reject">FAST_REJECT</span>`;
    case "REDIRECT":
      return `<span class="badge b-redir">REDIRECT</span>`;
    case "IGNORED_FAKE_PROBE":
      return `<span class="badge b-probe">FAKE_PROBE</span>`;
    default:
      return `<span class="badge">${outcome}</span>`;
  }
}

function buildClusterStats(records) {
  const clusters = new Map();
  for (const r of records) {
    if (r.parsed?.isFakeProbe) continue;
    const key = r.parsed?.snCluster || r.parsed?.host || "unknown";
    if (!clusters.has(key)) {
      clusters.set(key, {
        cluster: key,
        ips: new Set(),
        ok: 0,
        fallbackOk: 0,
        stalls: 0,
        fastReject: 0,
        redirects: 0,
        totalOkMs: 0,
        okCount: 0
      });
    }
    const c = clusters.get(key);
    if (r.serverIp) c.ips.add(r.serverIp);

    if (r.outcome === "OK_PRIMARY") {
      c.ok++;
      c.totalOkMs += r.durationMs || 0;
      c.okCount++;
    } else if (r.outcome === "OK_FALLBACK") {
      c.fallbackOk++;
      c.totalOkMs += r.durationMs || 0;
      c.okCount++;
    } else if (
      r.outcome === "STALL_5S_TIMEOUT" ||
      r.outcome === "NETWORK_ERROR" ||
      r.outcome === "SLOW_TTFB_STALL"
    ) {
      c.stalls++;
    } else if (r.outcome === "FAST_REJECT_ROUTE") {
      c.fastReject++;
    } else if (r.outcome === "REDIRECT") {
      c.redirects++;
    }
  }
  return Array.from(clusters.values());
}

function render(state) {
  currentState = state;
  const records = state.records || [];
  const inFlight = state.inFlight || [];
  const hideProbes = document.getElementById("chk-hide-probes").checked;

  let okCount = 0;
  let fallbackCount = 0;
  let stallCount = 0;
  let rejectCount = 0;
  let probeCount = 0;

  for (const r of records) {
    if (r.outcome === "OK_PRIMARY") okCount++;
    else if (r.outcome === "OK_FALLBACK") fallbackCount++;
    else if (
      r.outcome === "STALL_5S_TIMEOUT" ||
      r.outcome === "NETWORK_ERROR" ||
      r.outcome === "SLOW_TTFB_STALL"
    )
      stallCount++;
    else if (r.outcome === "FAST_REJECT_ROUTE") rejectCount++;
    else if (r.outcome === "IGNORED_FAKE_PROBE") probeCount++;
  }

  document.getElementById("st-ok").textContent = okCount;
  document.getElementById("st-fallback").textContent = fallbackCount;
  document.getElementById("st-stall").textContent = stallCount;
  document.getElementById("st-reject").textContent = rejectCount;
  document.getElementById("st-probe").textContent = probeCount;

  const inflightEl = document.getElementById("inflight-count");
  if (inFlight.length > 0) {
    const maxElapsed = Math.max(...inFlight.map((i) => i.elapsedMs || 0));
    inflightEl.innerHTML = `<span style="color:${maxElapsed > 2500 ? "var(--red)" : "var(--orange)"}">${inFlight.length} in-flight (oldest: ${maxElapsed}ms)</span>`;
  } else {
    inflightEl.textContent = "0 in-flight";
  }

  // Render cluster breakdown
  const clusterStats = buildClusterStats(records);
  const clusterTbody = document.getElementById("cluster-tbody");
  if (clusterStats.length === 0) {
    clusterTbody.innerHTML = `<tr><td colspan="8" style="color:var(--muted);text-align:center;">No requests recorded yet. Play or seek a YouTube video.</td></tr>`;
  } else {
    clusterTbody.innerHTML = clusterStats
      .map((c) => {
        const avgMs = c.okCount > 0 ? Math.round(c.totalOkMs / c.okCount) : "-";
        const ipsStr = Array.from(c.ips).join(", ") || "-";
        return `<tr>
          <td title="${c.cluster}">${c.cluster}</td>
          <td title="${ipsStr}">${ipsStr}</td>
          <td style="color:#56d364">${c.ok}</td>
          <td style="color:var(--blue)">${c.fallbackOk}</td>
          <td style="color:${c.stalls > 0 ? "var(--red)" : "var(--muted)"};font-weight:${c.stalls > 0 ? "700" : "400"}">${c.stalls}</td>
          <td style="color:var(--purple)">${c.fastReject}</td>
          <td style="color:var(--orange)">${c.redirects}</td>
          <td>${avgMs}ms</td>
        </tr>`;
      })
      .join("");
  }

  // Render recent rows
  const recentTbody = document.getElementById("recent-tbody");
  const filtered = records
    .filter((r) => !hideProbes || r.outcome !== "IGNORED_FAKE_PROBE")
    .slice(-120)
    .reverse();

  recentTbody.innerHTML = filtered
    .map((r) => {
      const timeStr = (r.startedAtIso || "").slice(11, 23);
      const vidStr = r.videoId || "-";
      const rnStr = r.parsed?.rn ?? "-";
      const hostStr = r.parsed?.snCluster
        ? `${r.parsed.rrNode}.${r.parsed.snCluster}`
        : r.parsed?.host || "-";
      const ipStr = r.serverIp || (r.error ? r.error.replace("net::", "") : "-");
      const durStr = `${r.durationMs ?? "-"}ms`;

      return `<tr>
        <td>${timeStr}</td>
        <td title="${r.videoTitle || ""}">${vidStr}</td>
        <td>${rnStr}</td>
        <td title="${r.parsed?.host || ""}\nmn=${r.parsed?.mn || ""}">${hostStr}</td>
        <td title="${r.error || ""}">${ipStr}</td>
        <td>${badgeForOutcome(r.outcome)}</td>
        <td>${durStr}</td>
      </tr>`;
    })
    .join("");
}

function generateDiagnosticReport(state) {
  const clusterStats = buildClusterStats(state.records || []).map((c) => ({
    ...c,
    ips: Array.from(c.ips),
    avgOkMs: c.okCount > 0 ? Math.round(c.totalOkMs / c.okCount) : null
  }));

  const problemRequests = (state.records || [])
    .filter(
      (r) =>
        r.outcome === "STALL_5S_TIMEOUT" ||
        r.outcome === "NETWORK_ERROR" ||
        r.outcome === "SLOW_TTFB_STALL" ||
        r.outcome === "REDIRECT" ||
        r.outcome === "FAST_REJECT_ROUTE"
    )
    .slice(-60)
    .map((r) => ({
      time: r.startedAtIso,
      videoId: r.videoId,
      rn: r.parsed?.rn,
      host: r.parsed?.host,
      snCluster: r.parsed?.snCluster,
      mn: r.parsed?.mn,
      ms: r.parsed?.ms,
      fallbackCount: r.parsed?.fallbackCount,
      cmsRedirect: r.parsed?.cmsRedirect,
      serverIp: r.serverIp,
      statusCode: r.statusCode,
      error: r.error,
      ttfbMs: r.ttfbMs,
      durationMs: r.durationMs,
      outcome: r.outcome,
      redirectUrl: r.redirectUrl ? new URL(r.redirectUrl).hostname : null
    }));

  const sampleSuccesses = (state.records || [])
    .filter((r) => r.outcome === "OK_PRIMARY" || r.outcome === "OK_FALLBACK")
    .slice(-20)
    .map((r) => ({
      time: r.startedAtIso,
      videoId: r.videoId,
      rn: r.parsed?.rn,
      host: r.parsed?.host,
      snCluster: r.parsed?.snCluster,
      mn: r.parsed?.mn,
      fallbackCount: r.parsed?.fallbackCount,
      cmsRedirect: r.parsed?.cmsRedirect,
      serverIp: r.serverIp,
      ttfbMs: r.ttfbMs,
      durationMs: r.durationMs,
      outcome: r.outcome
    }));

  return {
    generatedAt: new Date().toISOString(),
    totalRecorded: (state.records || []).length,
    inFlight: state.inFlight || [],
    clusterSummary: clusterStats,
    playerEvents: (state.playerEvents || []).slice(-30),
    problemRequests,
    sampleSuccesses
  };
}

function refresh() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
    if (res) render(res);
  });
}

document.getElementById("chk-hide-probes").addEventListener("change", () => {
  render(currentState);
});

document.getElementById("btn-clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_STATE" }, () => {
    refresh();
  });
});

document.getElementById("btn-copy").addEventListener("click", async () => {
  const report = generateDiagnosticReport(currentState);
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  const toast = document.getElementById("toast");
  toast.textContent = "Copied diagnostic report!";
  setTimeout(() => (toast.textContent = ""), 2500);
});

document.getElementById("btn-export").addEventListener("click", () => {
  const report = {
    ...generateDiagnosticReport(currentState),
    allRecords: currentState.records
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `yt-telemetry-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
});

refresh();
setInterval(refresh, 1000);

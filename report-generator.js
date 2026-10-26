// ── Report generation for Space Junkyard Gardener ────────────────────────
// The only network call in this module goes to our own local backend at
// /api/report, which talks to Ollama on this machine. Catalog and user data
// are never sent to a hosted model API, and no API key is involved.
// If the local model is unavailable we fall back to a clearly labelled
// plain-language summary so the app stays usable — worded honestly for
// whichever data source is active (real CelesTrak catalogue or sample).

let hostedDeployment = false;

export function configureReportSource(config = {}) {
  hostedDeployment = config.deployment === 'vercel';
}

export async function generateReport({ counts, pattern, gardenDate, isSample }) {
  if (hostedDeployment) {
    return {
      report: fallbackReport(counts, pattern, true),
      source: 'Sample summary · hosted mode',
      origin: 'sample',
      model: null
    };
  }
  try {
    const response = await fetch('/api/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ counts, pattern, gardenDate, isSample: Boolean(isSample) })
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `Local endpoint returned HTTP ${response.status}`);
    }
    const data = await response.json();
    return {
      report: data.report,
      source: data.source || `Local model · ${data.model || 'ollama'}`,
      origin: 'local',
      model: data.model || null
    };
  } catch (error) {
    return {
      report: fallbackReport(counts, pattern, isSample),
      source: isSample
        ? 'Sample fallback · local model unavailable'
        : 'Offline summary · local model unavailable',
      origin: 'sample',
      detail: error && error.message ? error.message : String(error)
    };
  }
}

function fallbackReport(counts, pattern, isSample) {
  if (isSample) {
    return `The sample garden is showing ${counts.satellites} satellites and ${counts.debris} pieces of debris today. ${pattern} Think of it as a friendly snapshot of an illustrative sky — a starting point for exploring orbital neighbourhoods, not a picture of what is really overhead right now.`;
  }
  return `The local model is offline, so here is a plain summary instead: ${counts.satellites} satellites and ${counts.debris} debris objects from the CelesTrak catalogue are shown today. ${pattern} The figures come from the catalogue; the positions drawn in the scene stay decorative.`;
}

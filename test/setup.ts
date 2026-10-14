// Keep tests hermetic: a developer shell or service unit may export settings
// (including the legacy OCPI_ names, OpenChamber's OPENCODE_SERVER_* auth and
// the agent-directory overrides)
// that would otherwise leak into every test.
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("ANTECHAMBER_") ||
    key.startsWith("OCPI_") ||
    key.startsWith("OPENCODE_SERVER_") ||
    ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"].includes(key)
  )
    delete process.env[key];
}

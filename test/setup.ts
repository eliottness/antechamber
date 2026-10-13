// Keep tests hermetic: a developer shell or service unit may export settings
// (including the legacy OCPI_ names and OpenChamber's OPENCODE_SERVER_* auth)
// that would otherwise leak into every test.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("ANTECHAMBER_") || key.startsWith("OCPI_") || key.startsWith("OPENCODE_SERVER_")) delete process.env[key];
}

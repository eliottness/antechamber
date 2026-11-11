const PREFIX = "extensions/antechamber/";

type Manifest = {
  contributes: {
    panel: { icon?: string; entry?: string };
    page?: { entry?: string };
    statusSection?: { entry?: string };
    service?: { entry: string };
  } & Record<string, unknown>;
} & Record<string, unknown>;

/** The extension's manifest with its package paths rebased onto the repository root. */
export function rootManifest(manifest: Manifest): Manifest {
  const at = (path: string | undefined) => (path === undefined ? undefined : PREFIX + path);
  const { panel, page, statusSection, service } = manifest.contributes;
  return {
    ...manifest,
    contributes: {
      ...manifest.contributes,
      panel: {
        ...panel,
        ...(panel.icon?.endsWith(".svg") ? { icon: at(panel.icon) } : {}),
        ...(panel.entry ? { entry: at(panel.entry) } : {}),
      },
      ...(page ? { page: { ...page, ...(page.entry ? { entry: at(page.entry) } : {}) } } : {}),
      ...(statusSection
        ? { statusSection: { ...statusSection, ...(statusSection.entry ? { entry: at(statusSection.entry) } : {}) } }
        : {}),
      ...(service ? { service: { ...service, entry: at(service.entry) as string } } : {}),
    },
  };
}

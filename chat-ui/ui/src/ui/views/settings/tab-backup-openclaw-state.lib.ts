interface OpenclawStateArchiveSelection {
  canceled: boolean;
  filePath?: string;
}

interface OpenclawStateImportDeps {
  selectArchive: () => Promise<OpenclawStateArchiveSelection>;
  confirmImport: (filePath: string) => Promise<boolean>;
  importArchive: (filePath: string) => Promise<void>;
}

export async function runOpenclawStateImport(
  deps: OpenclawStateImportDeps,
): Promise<"canceled" | "imported"> {
  const selection = await deps.selectArchive();
  if (selection.canceled || !selection.filePath) return "canceled";
  if (!(await deps.confirmImport(selection.filePath))) return "canceled";

  // The protected import lifecycle validates the archive before stopping the
  // gateway, so no separate renderer-side preflight is needed.
  await deps.importArchive(selection.filePath);
  return "imported";
}

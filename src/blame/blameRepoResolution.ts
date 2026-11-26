export interface BlameRepositoryResolver {
  getRepoRootForFile(filePath: string): string | null;
}

export function resolveBlameRepository(
  coordinator: BlameRepositoryResolver,
  filePath: string,
): string | null {
  return coordinator.getRepoRootForFile(filePath);
}

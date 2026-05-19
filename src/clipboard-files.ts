import { Notice } from "obsidian";
import type { App } from "obsidian";

type ClipboardFileSource = FileList | readonly File[];

export function hasClipboardFiles(event: ClipboardEvent): boolean {
  return (event.clipboardData?.files?.length ?? 0) > 0;
}

export async function importClipboardFiles(
  app: App,
  files: ClipboardFileSource,
  sourcePath: string
): Promise<string[]> {
  const links: string[] = [];
  const failures: string[] = [];

  for (const file of Array.from(files)) {
    if (!file.name) {
      failures.push("未命名文件");
      continue;
    }

    try {
      const targetPath = await app.fileManager.getAvailablePathForAttachment(file.name, sourcePath);
      const content = await file.arrayBuffer();
      const createdFile = await app.vault.createBinary(targetPath, content);
      links.push(app.fileManager.generateMarkdownLink(createdFile, sourcePath));
    } catch (error) {
      failures.push(`${file.name}: ${formatImportError(error)}`);
    }
  }

  if (failures.length > 0) {
    new Notice(`剪贴板文件导入失败：${failures.join("；")}`);
  }

  return links;
}

function formatImportError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

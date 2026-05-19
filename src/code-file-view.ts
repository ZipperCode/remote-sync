import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting
} from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers
} from "@codemirror/view";
import { TextFileView } from "obsidian";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { hasClipboardFiles, importClipboardFiles } from "./clipboard-files";

export const CODE_VIEW_TYPE = "remote-sync-code-view";

type SupportedCodeExtension =
  | "css"
  | "html"
  | "js"
  | "json"
  | "jsx"
  | "py"
  | "ts"
  | "tsx"
  | "xml"
  | "yaml"
  | "yml";

type LanguageConfig = {
  label: string;
  createExtension: () => Extension;
};

const LANGUAGE_CONFIG: Record<SupportedCodeExtension, LanguageConfig> = {
  css: {
    label: "CSS",
    createExtension: () => css()
  },
  html: {
    label: "HTML",
    createExtension: () => html()
  },
  js: {
    label: "JavaScript",
    createExtension: () => javascript()
  },
  json: {
    label: "JSON",
    createExtension: () => json()
  },
  jsx: {
    label: "JSX",
    createExtension: () => javascript({ jsx: true })
  },
  py: {
    label: "Python",
    createExtension: () => python()
  },
  ts: {
    label: "TypeScript",
    createExtension: () => javascript({ typescript: true })
  },
  tsx: {
    label: "TSX",
    createExtension: () => javascript({ jsx: true, typescript: true })
  },
  xml: {
    label: "XML",
    createExtension: () => xml()
  },
  yaml: {
    label: "YAML",
    createExtension: () => yaml()
  },
  yml: {
    label: "YAML",
    createExtension: () => yaml()
  }
};

export const SUPPORTED_CODE_EXTENSIONS = Object.keys(LANGUAGE_CONFIG) as SupportedCodeExtension[];

const SUPPORTED_CODE_EXTENSION_SET = new Set<string>(SUPPORTED_CODE_EXTENSIONS);

const EDITOR_THEME = EditorView.theme({
  "&": {
    height: "100%"
  },
  ".cm-scroller": {
    fontFamily: "var(--font-monospace)",
    overflow: "auto"
  },
  ".cm-content": {
    minHeight: "100%"
  }
});

export function isSupportedCodeExtension(extension: string): boolean {
  return SUPPORTED_CODE_EXTENSION_SET.has(extension.toLowerCase());
}

export function getCodeLanguageLabel(extension: string | null): string {
  if (!extension) {
    return "Plain text";
  }

  return LANGUAGE_CONFIG[extension as SupportedCodeExtension]?.label ?? "Plain text";
}

function getFileExtension(file: TFile | null): string | null {
  return file?.extension?.toLowerCase() ?? null;
}

function getLanguageExtension(file: TFile | null): Extension | null {
  const extension = getFileExtension(file);
  if (!extension) {
    return null;
  }

  return LANGUAGE_CONFIG[extension as SupportedCodeExtension]?.createExtension() ?? null;
}

export class RemoteSyncCodeView extends TextFileView {
  private editor: EditorView | null = null;
  private headerPathEl: HTMLElement | null = null;
  private headerLanguageEl: HTMLElement | null = null;
  private editorHostEl: HTMLElement | null = null;
  private isApplyingExternalUpdate = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return CODE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.name ?? "Code";
  }

  canAcceptExtension(extension: string): boolean {
    return isSupportedCodeExtension(extension);
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("remote-sync-code-view");

    const headerEl = this.contentEl.createDiv({ cls: "remote-sync-code-view__header" });
    this.headerPathEl = headerEl.createDiv({ cls: "remote-sync-code-view__path" });
    this.headerLanguageEl = headerEl.createDiv({ cls: "remote-sync-code-view__language" });
    this.editorHostEl = this.contentEl.createDiv({ cls: "remote-sync-code-view__editor" });
    this.registerDomEvent(this.editorHostEl, "paste", (event: ClipboardEvent) => {
      const files = event.clipboardData?.files;
      if (!files || !hasClipboardFiles(event)) {
        return;
      }

      event.preventDefault();
      void this.importPastedFiles(files);
    });

    this.ensureEditor();
    this.updateHeader();
  }

  async onClose(): Promise<void> {
    this.destroyEditor();
    this.contentEl.empty();
  }

  async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    this.updateHeader();
  }

  async onUnloadFile(file: TFile): Promise<void> {
    await super.onUnloadFile(file);
    this.updateHeader();
  }

  async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    this.resetEditorState(this.getViewData());
    this.updateHeader();
  }

  getViewData(): string {
    return this.editor?.state.doc.toString() ?? this.data;
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;

    if (!this.editor) {
      return;
    }

    if (clear) {
      this.resetEditorState(data);
      return;
    }

    this.applyDocumentUpdate(data);
  }

  clear(): void {
    this.data = "";
    this.resetEditorState("");
  }

  private ensureEditor(): void {
    if (!this.editorHostEl || this.editor) {
      return;
    }

    this.editor = new EditorView({
      state: this.createEditorState(this.data),
      parent: this.editorHostEl
    });
  }

  private async importPastedFiles(files: FileList): Promise<void> {
    const links = await importClipboardFiles(this.app, files, this.file?.path ?? "");
    if (!this.editor || links.length === 0) {
      return;
    }

    this.editor.dispatch(this.editor.state.replaceSelection(links.join("\n")));
  }

  private destroyEditor(): void {
    this.editor?.destroy();
    this.editor = null;
    this.headerPathEl = null;
    this.headerLanguageEl = null;
    this.editorHostEl = null;
  }

  private createEditorState(content: string): EditorState {
    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      highlightActiveLine(),
      bracketMatching(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.editable.of(this.file !== null),
      EditorState.readOnly.of(this.file === null),
      EDITOR_THEME,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) {
          return;
        }

        this.data = update.state.doc.toString();

        if (!this.isApplyingExternalUpdate) {
          this.requestSave();
        }
      })
    ];

    const languageExtension = getLanguageExtension(this.file);
    if (languageExtension) {
      extensions.push(languageExtension);
    }

    return EditorState.create({
      doc: content,
      extensions
    });
  }

  private resetEditorState(content: string): void {
    if (!this.editorHostEl) {
      return;
    }

    this.editor?.destroy();
    this.editor = new EditorView({
      state: this.createEditorState(content),
      parent: this.editorHostEl
    });
  }

  private applyDocumentUpdate(content: string): void {
    if (!this.editor) {
      return;
    }

    const currentContent = this.editor.state.doc.toString();
    if (currentContent === content) {
      return;
    }

    this.isApplyingExternalUpdate = true;
    this.editor.dispatch({
      changes: {
        from: 0,
        to: this.editor.state.doc.length,
        insert: content
      }
    });
    this.isApplyingExternalUpdate = false;
  }

  private updateHeader(): void {
    if (this.headerPathEl) {
      this.headerPathEl.setText(this.file?.path ?? "No file selected");
    }

    if (this.headerLanguageEl) {
      this.headerLanguageEl.setText(getCodeLanguageLabel(getFileExtension(this.file)));
    }
  }
}

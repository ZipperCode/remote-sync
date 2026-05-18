import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type RemoteSyncPlugin from "./main";
import { parseCustomHeaders } from "./src/custom-headers";
import { normalizeRemoteRoot } from "./src/path-utils";
import { getDefaultS3Options, S3AddressingStyle, S3Preset } from "./src/s3-remote";

export type RemoteProvider = "webdav" | "s3";
type RemoteProviderOption = "webdav" | S3Preset;

export interface RemoteSyncSettings {
  provider: RemoteProvider;
  baseUrl: string;
  username: string;
  password: string;
  remoteRoot: string;
  customHeaders: string;
  s3Preset: S3Preset;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3SessionToken: string;
  s3AddressingStyle: S3AddressingStyle;
  ignorePatterns: string[];
}

export const DEFAULT_SETTINGS: RemoteSyncSettings = {
  provider: "webdav",
  baseUrl: "",
  username: "",
  password: "",
  remoteRoot: "",
  customHeaders: "",
  s3Preset: "custom",
  s3Endpoint: "",
  s3Region: "us-east-1",
  s3Bucket: "",
  s3Prefix: "",
  s3AccessKeyId: "",
  s3SecretAccessKey: "",
  s3SessionToken: "",
  s3AddressingStyle: "path",
  ignorePatterns: []
};

export function normalizeRemoteSyncSettings(
  settings: Partial<RemoteSyncSettings> | undefined,
  vaultName: string
): RemoteSyncSettings {
  const normalized = {
    ...DEFAULT_SETTINGS,
    ...settings
  };

  if (!normalized.provider) {
    normalized.provider = "webdav";
  }
  if (!normalized.remoteRoot) {
    normalized.remoteRoot = normalizeRemoteRoot(vaultName);
  }
  normalized.remoteRoot = normalizeRemoteRoot(normalized.remoteRoot);
  normalized.s3Prefix = normalizeRemoteRoot(normalized.s3Prefix);
  normalized.ignorePatterns = normalized.ignorePatterns ?? [];

  return normalized;
}

export class RemoteSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: RemoteSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("远端类型")
      .setDesc("选择 WebDAV、Amazon S3、Cloudflare R2 或兼容 S3 的服务。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("webdav", "WebDAV")
          .addOption("aws", "Amazon S3")
          .addOption("r2", "Cloudflare R2")
          .addOption("custom", "S3 兼容服务")
          .setValue(selectedProviderOption(this.plugin.settings))
          .onChange(async (value) => {
            const option = value as RemoteProviderOption;
            if (option === "webdav") {
              this.plugin.settings.provider = "webdav";
            } else {
              this.plugin.settings.provider = "s3";
              this.plugin.settings.s3Preset = option;
              const defaults = getDefaultS3Options(option);
              this.plugin.settings.s3Region = defaults.region;
              this.plugin.settings.s3AddressingStyle = defaults.addressingStyle;
            }
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.provider === "webdav") {
      this.displayWebDavSettings(containerEl);
    } else {
      this.displayS3Settings(containerEl);
    }

    new Setting(containerEl).setName("通用请求").setHeading();

    new Setting(containerEl)
      .setName("自定义请求头")
      .setDesc("每行一个 Header-Name: value。Authorization、Host、Content-Length 和 x-amz-* 由插件管理。")
      .addTextArea((text) =>
        text
          .setPlaceholder("User-Agent: RemoteSync")
          .setValue(this.plugin.settings.customHeaders)
          .onChange(async (value) => {
            try {
              parseCustomHeaders(value);
              this.plugin.settings.customHeaders = value;
              await this.plugin.saveSettings();
            } catch (error) {
              new Notice(formatError(error));
            }
          })
      );

    new Setting(containerEl)
      .setName("忽略规则")
      .setDesc("每行一个 gitignore-like 规则，支持 # 注释、目录规则、glob 和 ! 反向包含。.obsidian、隐藏路径和回收站始终会跳过。")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.ignorePatterns.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.ignorePatterns = value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("回收站")
      .setDesc(".remote-sync-trash/ 会在覆盖或删除前保存旧文件，并自动排除在同步范围外。");

    new Setting(containerEl)
      .setName("测试连接")
      .setDesc("使用当前远端配置发送一次测试请求。")
      .addButton((button) =>
        button
          .setButtonText("测试")
          .onClick(async () => {
            try {
              await this.plugin.testConnection();
              new Notice("远端连接可用。");
            } catch (error) {
              new Notice(`远端连接失败：${formatError(error)}`);
            }
          })
      );

    new Setting(containerEl).setName("同步").setHeading();

    new Setting(containerEl)
      .setName("自动同步")
      .setDesc("已启用。文件新增、修改、删除或重命名后，会在 3 秒无新变化时自动同步。");

    new Setting(containerEl)
      .setName("手动同步")
      .setDesc("立即执行一次远端同步。")
      .addButton((button) =>
        button
          .setButtonText("立即同步")
          .setCta()
          .onClick(() => {
            void this.plugin.syncNow();
          })
      );
  }

  private displayWebDavSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("WebDAV").setHeading();

    new Setting(containerEl)
      .setName("WebDAV 地址")
      .setDesc("WebDAV 服务端地址。下方远程根目录会追加在该地址后。")
      .addText((text) =>
        text
          .setPlaceholder("https://example.com/remote.php/dav/files/user")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("用户名")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => {
            this.plugin.settings.username = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("密码")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("远程根目录")
      .setDesc("默认使用当前库名称。Obsidian 配置目录会自动跳过。")
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(this.plugin.settings.remoteRoot)
          .onChange(async (value) => {
            this.plugin.settings.remoteRoot = normalizeRemoteRoot(value);
            await this.plugin.saveSettings();
          })
      );
  }

  private displayS3Settings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("S3").setHeading();

    new Setting(containerEl)
      .setName("Endpoint")
      .setDesc("AWS 可填写 https://s3.<region>.amazonaws.com；R2 形如 https://<account-id>.r2.cloudflarestorage.com。")
      .addText((text) =>
        text
          .setPlaceholder(endpointPlaceholder(this.plugin.settings.s3Preset))
          .setValue(this.plugin.settings.s3Endpoint)
          .onChange(async (value) => {
            this.plugin.settings.s3Endpoint = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Region")
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.settings.s3Preset === "r2" ? "auto" : "us-east-1")
          .setValue(this.plugin.settings.s3Region)
          .onChange(async (value) => {
            this.plugin.settings.s3Region = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Bucket")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.s3Bucket)
          .onChange(async (value) => {
            this.plugin.settings.s3Bucket = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Prefix")
      .setDesc("可选。仅作为对象 key 前缀，不创建文件夹对象。")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.s3Prefix)
          .onChange(async (value) => {
            this.plugin.settings.s3Prefix = normalizeRemoteRoot(value);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Access Key ID")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.s3AccessKeyId)
          .onChange(async (value) => {
            this.plugin.settings.s3AccessKeyId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Secret Access Key")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setValue(this.plugin.settings.s3SecretAccessKey)
          .onChange(async (value) => {
            this.plugin.settings.s3SecretAccessKey = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Session Token")
      .setDesc("可选。使用临时凭证时填写。")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.s3SessionToken)
          .onChange(async (value) => {
            this.plugin.settings.s3SessionToken = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("地址风格")
      .setDesc("AWS 默认 virtual-hosted；R2 和通用兼容服务默认 path-style。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("path", "Path-style")
          .addOption("virtual-hosted", "Virtual-hosted")
          .setValue(this.plugin.settings.s3AddressingStyle)
          .onChange(async (value) => {
            this.plugin.settings.s3AddressingStyle = value as S3AddressingStyle;
            await this.plugin.saveSettings();
          })
      );
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectedProviderOption(settings: RemoteSyncSettings): RemoteProviderOption {
  return settings.provider === "webdav" ? "webdav" : settings.s3Preset;
}

function endpointPlaceholder(preset: S3Preset): string {
  if (preset === "aws") {
    return "https://s3.us-east-1.amazonaws.com";
  }
  if (preset === "r2") {
    return "https://<account-id>.r2.cloudflarestorage.com";
  }
  return "https://s3.example.com";
}

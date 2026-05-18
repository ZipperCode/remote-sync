# 远端同步

用于 Obsidian 普通库文件和附件的轻量双向同步插件，支持 WebDAV 与 S3-compatible 远端。

## 范围

- 默认启用自动同步：文件新增、修改、删除或重命名后，等待 3 秒无新变化再同步。
- 保留 Ribbon、命令面板和设置页的手动同步入口。
- 支持 WebDAV、Amazon S3、Cloudflare R2 和通用 S3 兼容服务。
- 通过 Obsidian `requestUrl` 兼容桌面端和移动端。
- 可配置全局自定义请求头，每行 `Header-Name: value`，适用于 `User-Agent` 等服务端要求。
- 跳过 `.obsidian`、隐藏路径、临时文件和自定义忽略规则。
- 双方都变化时使用较新的 `mtime` 决定覆盖方向。
- `mtime` 相同但大小不同的文件会记录冲突，不静默覆盖。

当前不包含端到端加密、Markdown 合并、multipart upload、服务端加密、ACL、对象版本管理和 Obsidian 配置同步。

## 远端配置

### WebDAV

填写 WebDAV 地址、用户名、密码和远程根目录。旧版本保存的 WebDAV 配置会自动按 WebDAV 远端读取。

### S3-compatible

设置页可选择：

- `Amazon S3`：默认 `region = us-east-1`，默认 `virtual-hosted` 地址风格。
- `Cloudflare R2`：默认 `region = auto`，默认 `path-style` 地址风格，Endpoint 形如 `https://<account-id>.r2.cloudflarestorage.com`。
- `S3 兼容服务`：默认 `path-style`，需服务端支持 SigV4 和 `ListObjectsV2`。

S3 配置包含 Endpoint、Region、Bucket、Prefix、Access Key ID、Secret Access Key、可选 Session Token 和地址风格。`Prefix` 只作为对象 key 前缀，不创建文件夹对象。

### 自定义请求头

每行一个请求头：

```text
User-Agent: RemoteSync
X-Trace-Id: example
```

空行会忽略；格式错误会提示具体行号。`Authorization`、`Host`、`Content-Length` 和 `x-amz-*` 由插件管理，不能在自定义请求头中覆盖。其他与协议内置头重名时，以插件内置头为准。

## 开发

```bash
npm install
npm test
npm run build
```

发布文件：

- `manifest.json`
- `main.js`
- `styles.css`

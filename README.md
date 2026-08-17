# dsh‑ctf‑collaborate

**DSH CTF 协作**插件代码仓库。

## 仓库目录说明

- `dsh‑ctf-team/` — 插件程序包

## 快速安装

在仓库根目录下执行：
```sh
dsh plugin --profile web add file:./dsh-ctf-team
```
随后重启 Harness 服务进程。

## 开发部署
```sh
cd dsh-ctf-team
npm install
npm run build
npm test
```

## 注意事项
- 本程序包要求 Node.js 版本 ≥ 22.5
- 详细的功能介绍、运行机制以及桥接接口说明，请查阅 `dsh‑ctf-team/README.md`

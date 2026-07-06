#!/usr/bin/env racket
#lang racket/base

;; setup.rkt — 一键部署 pi 配置
;; 用法: racket setup.rkt
;;       chmod +x setup.rkt && ./setup.rkt

(require racket/file
         racket/path
         racket/string
         racket/system)

(define target-dir (build-path (find-system-path 'home-dir) ".pi" "agent"))
(define src-dir (path-only (normalize-path (find-system-path 'run-file))))

(printf "==> 部署 pi 配置到 ~a\n" target-dir)
(make-directory* target-dir)

;; ── 复制文件 ────────────────────────────────────────────
(for ([file '("settings.json" "SYSTEM.md" "PI_DOCS.md")])
  (let ([src (build-path src-dir file)]
        [dst (build-path target-dir file)])
    (copy-file src dst #t)
    (printf "    ✓ ~a\n" file)))

;; ── 安装扩展 ────────────────────────────────────────────
(let ([ext-dir (build-path target-dir "extensions")])
  (make-directory* ext-dir)
  (for ([ext '("bracket-check.ts" "ssh-password.ts")])
    (copy-file (build-path src-dir "extensions" ext)
               (build-path ext-dir ext) #t)
    (printf "    ✓ extensions/~a\n" ext)))

;; ── 交互式设置 API Key ──────────────────────────────────
(define auth-file (build-path target-dir "auth.json"))
(if (file-exists? auth-file)
    (printf "==> auth.json 已存在，跳过\n")
    (begin
      (printf "\n==> 设置 DeepSeek API Key\n")
      (printf "    获取 key: https://platform.deepseek.com/api_keys\n")
      (display "    粘贴 API Key (回车跳过): ")
      (flush-output)
      (let ([key (string-trim (read-line))])
        (if (positive? (string-length key))
          (begin
            (call-with-output-file auth-file
              (lambda (out)
                (fprintf out "{\"deepseek\":{\"type\":\"api_key\",\"key\":\"~a\"}}" key))
              #:exists 'replace)
            (system (format "chmod 600 ~a" auth-file))
            (printf "    ✓ 已写入 ~a\n" auth-file))
          (printf "    ⚠ 已跳过，之后可手动写入 ~a\n" auth-file)))))

;; ── 添加 alias 到 ~/.bashrc ─────────────────────────────
(define bashrc (build-path (find-system-path 'home-dir) ".bashrc"))
(define marker "alias pi-doc=")
(if (string-contains? (file->string bashrc) marker)
    (printf "==> .bashrc 中已有 pi alias，跳过\n")
    (begin
      (printf "==> 添加 pi alias 到 .bashrc\n")
      (call-with-output-file bashrc
        (lambda (out)
          (display (file->string bashrc) out)
          (display "\n\n# pi aliases\nalias pi='pi'\nalias pi-doc='pi --append-system-prompt \"$(cat ~/.pi/agent/PI_DOCS.md)\"'\n" out))
        #:exists 'replace)
      (printf "    ✓ 已添加，执行 source ~/.bashrc 生效\n")))

(printf "\n    ✓ 全部完成！\n")
(printf "    pi       — 精简模式\n")
(printf "    pi-doc   — 带 pi 文档\n")
(printf "    Ctrl+P   — DeepSeek Flash ↔ Pro 切换\n")

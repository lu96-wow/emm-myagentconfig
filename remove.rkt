#!/usr/bin/env racket
#lang racket/base

;; remove.rkt — 一键卸载 pi 配置
;; 用法: racket remove.rkt

(require racket/file
         racket/path
         racket/string
         racket/system)

(define target-dir (build-path (find-system-path 'home-dir) ".pi" "agent"))

(printf "==> 卸载 pi 配置\n")

;; ── 删除部署文件 ──────────────────────────────────────
(for ([file '("settings.json" "SYSTEM.md" "PI_DOCS.md")])
  (let ([p (build-path target-dir file)])
    (if (file-exists? p)
        (begin (delete-file p) (printf "    ✗ ~a\n" file))
        (printf "    - ~a (不存在)\n" file))))

;; ── 删除扩展 ──────────────────────────────────────────
(let ([ext-dir (build-path target-dir "extensions")])
  (for ([ext '("bracket-check.ts" "ssh-password.ts")])
    (let ([p (build-path ext-dir ext)])
      (if (file-exists? p)
          (begin (delete-file p) (printf "    ✗ extensions/~a\n" ext))
          (printf "    - extensions/~a (不存在)\n" ext)))))

;; ── 清理 .bashrc 中的 alias ───────────────────────────
(define bashrc (build-path (find-system-path 'home-dir) ".bashrc"))
(when (file-exists? bashrc)
  (define old-lines (string-split (file->string bashrc) "\n"))
  (define in-block? #f)
  (define changed? #f)
  (define cleaned
    (for/list ([line (in-list old-lines)])
      (cond
        [(string-prefix? line "# >>> pi aliases")
         (set! in-block? #t) (set! changed? #t) #f]
        [in-block?
         (when (string-prefix? line "# <<< pi aliases") (set! in-block? #f))
         #f]
        [(or (string-prefix? line "alias pi=")
             (string-prefix? line "alias pi-doc=")
             (string-prefix? line "alias pi-ssh=")
             (equal? line "# pi aliases"))
         (set! changed? #t) #f]
        [else line])))
  (when changed?
    (call-with-output-file bashrc
      (lambda (out)
        (for ([line (in-list cleaned)] #:when line)
          (display line out)
          (newline out)))
      #:exists 'replace)
    (printf "    ✓ 已清理 .bashrc 中的 pi alias\n"))
  (unless changed?
    (printf "    - .bashrc 中无 pi alias\n")))

(printf "\n    ✓ 卸载完成。auth.json 已保留（含 API Key）。\n")

/** Real-shaped unified-diff fixtures shared by engine tests. */

export const MODIFIED_FILE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,7 @@
 import x from "x";

-export function add(a, b) {
-  return a - b;
+export function add(a: number, b: number) {
+  return a + b;
 }
+
+export const VERSION = "1.0.0";`;

export const RENAMED_FILE_DIFF = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
index 1111111..2222222 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -10,3 +10,3 @@ export function f() {
 a
-b
+c
 d`;

export const PURE_RENAME_DIFF = `diff --git a/was.ts b/is.ts
similarity index 100%
rename from was.ts
rename to is.ts`;

export const NEW_FILE_DIFF = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file`;

export const DELETED_FILE_DIFF = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index e69de29..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world`;

export const BINARY_FILE_DIFF = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ`;

export const LOCKFILE_DIFF = `diff --git a/package-lock.json b/package-lock.json
index 1111111..2222222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 {
-  "version": "1.0.0",
+  "version": "1.0.1",
 }`;

export const MULTI_FILE_DIFF = [
  MODIFIED_FILE_DIFF,
  NEW_FILE_DIFF,
  DELETED_FILE_DIFF,
  BINARY_FILE_DIFF,
  LOCKFILE_DIFF,
].join("\n");

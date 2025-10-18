 const IndexFactory = require('@tryghost/algolia-indexer');
 const transforms = require('@tryghost/algolia-fragmenter');

+// --- byte-safe clamp helpers ---
+const MAX_RECORD_BYTES = 8000; // keep well under Algolia's 10k hard limit
+const JSON_SOFT_LIMIT = 9500;  // full record (stringified) soft ceiling
+const encoder = new TextEncoder();
+
+function clampByBytes(str, limit = MAX_RECORD_BYTES) {
+    if (!str) return str;
+    let lo = 0, hi = str.length, ans = '';
+    while (lo <= hi) {
+        const mid = (lo + hi) >> 1;
+        const slice = str.slice(0, mid);
+        if (encoder.encode(slice).length <= limit) { ans = slice; lo = mid + 1; }
+        else { hi = mid - 1; }
+    }
+    return ans;
+}
+
 exports.handler = async (event) => {
     // We only support POST
     if (event.httpMethod !== 'POST') {
         return {
             statusCode: 405,
             body: 'Method Not Allowed'
         };
     }
@@
         const hasTextInHtml = post.html && post.html.replace(/<[^>]*>/g, '').trim().length > 0;

-        // Use excerpt or plaintext if html is not provided or has no text
-        if (!hasTextInHtml) {
-            if (post.custom_excerpt) {
-                post.html = `<p>${post.custom_excerpt}</p>`;
-                console.log('Using custom_excerpt for indexing as html has no text.');
-            } else if (post.plaintext) {
-                post.html = `<p>${post.plaintext}</p>`;
-                console.log('Using plaintext for indexing as html has no text.');
-            } else if (post.title) {
-                post.html = `<p>${post.title}</p>`;
-                console.log('Using title for indexing as html, custom_excerpt, and plaintext are empty.');
-            }
-        }
+        // Prefer plaintext; avoid inflating size by wrapping into HTML
+        if (!hasTextInHtml) {
+            // ensure plaintext exists, clamp aggressively
+            if (post.custom_excerpt) {
+                post.plaintext = clampByBytes(post.custom_excerpt, MAX_RECORD_BYTES);
+            } else if (post.plaintext) {
+                post.plaintext = clampByBytes(post.plaintext, MAX_RECORD_BYTES);
+            } else if (post.title) {
+                post.plaintext = clampByBytes(post.title, MAX_RECORD_BYTES);
+            }
+            // make sure we DON'T send giant html
+            delete post.html;
+        } else {
+            // html exists, but it can be huge—prefer plaintext anyway if available
+            if (post.plaintext) {
+                post.plaintext = clampByBytes(post.plaintext, MAX_RECORD_BYTES);
+                delete post.html; // force fragmenter to rely on plaintext
+            }
+        }
@@
         const node = [post];
         const algoliaObject = transforms.transformToAlgoliaObject(node);
         console.log('Transformed to Algolia object.');

         const fragments = algoliaObject.reduce(transforms.fragmentTransformer, []);
         console.log(`Created ${fragments.length} fragments to be indexed.`);
 
+        // Final safeguard: clamp any oversized fragment fields
+        const safeFragments = fragments.map((frag) => {
+            // common payload fields that can blow up, depending on fragmenter version
+            if (frag.plaintext) frag.plaintext = clampByBytes(frag.plaintext, MAX_RECORD_BYTES);
+            if (frag.html) delete frag.html; // never send html to Algolia
+            // if the whole record is still large, trim excerpt/description if present
+            let bytes = encoder.encode(JSON.stringify(frag)).length;
+            if (bytes > JSON_SOFT_LIMIT) {
+                if (frag.excerpt) frag.excerpt = clampByBytes(frag.excerpt, 600);
+                // re-check
+                bytes = encoder.encode(JSON.stringify(frag)).length;
+            }
+            return frag;
+        });
+
         if (fragments.length === 0) {
             console.log('No fragments were created, nothing to index. Exiting.');
             return {
                 statusCode: 200,
                 body: `Post "${post.title}" did not generate any fragments for indexing.`
             };
         }
 
         const index = new IndexFactory(algoliaSettings);
         await index.setSettingsForIndex();
-        await index.save(fragments);
+        await index.save(safeFragments);
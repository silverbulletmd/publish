import { asset } from "$sb/plugos-syscall/mod.ts";
import { editor, markdown, space } from "$sb/silverbullet-syscall/mod.ts";
import { readCodeBlockPage, readYamlPage } from "$sb/lib/yaml_page.ts";
import { renderMarkdownToHtml } from "$silverbullet/plugs/markdown/markdown_render.ts";

import Handlebars from "handlebars";

import {
  collectNodesOfType,
  ParseTree,
  renderToText,
  replaceNodesMatching,
} from "$sb/lib/tree.ts";
import { FileMeta } from "$silverbullet/common/types.ts";

type PublishConfig = {
  title?: string;
  indexPage?: string;
  removeHashtags?: boolean;
  publishAll?: boolean;
  tags?: string[];
  prefixes?: string[];
  template?: string;
  generateIndexJson?: boolean;
};

const defaultPublishConfig: PublishConfig = {
  removeHashtags: true,
  generateIndexJson: true,
};

async function generatePage(
  pageName: string,
  htmlPath: string,
  mdPath: string,
  publishedPages: string[],
  publishConfig: PublishConfig,
  destDir: string,
  template: Handlebars.TemplateDelegate<any>,
) {
  const text = await space.readPage(pageName);
  console.log("Writing", pageName);
  const mdTree = await markdown.parseMarkdown(text);
  const publishMd = cleanMarkdown(
    mdTree,
    publishConfig,
    publishedPages,
  );
  const attachments = collectAttachments(mdTree);
  for (const attachment of attachments) {
    try {
      const attachmentData = await space.readAttachment(attachment);
      console.log("Writing", `${destDir}/${attachment}`);
      await space.writeAttachment(`${destDir}/${attachment}`, attachmentData);
    } catch (e: any) {
      console.error("Error reading attachment", attachment, e.message);
    }
  }
  // Write .md file
  await space.writeAttachment(mdPath, new TextEncoder().encode(publishMd));
  // Write .html file
  await space.writeAttachment(
    htmlPath,
    new TextEncoder().encode(template({
      pageName,
      config: publishConfig,
      body: renderMarkdownToHtml(mdTree, {
        smartHardBreak: true,
        attachmentUrlPrefix: "/",
      }),
    })),
  );
}

export async function publishAll() {
  let publishConfig = defaultPublishConfig;
  try {
    const loadedPublishConfig: PublishConfig = await readYamlPage("PUBLISH");
    publishConfig = {
      ...publishConfig,
      ...loadedPublishConfig,
    };
  } catch (e: any) {
    console.warn("No PUBLISH page found, using defaults", e.message);
  }
  const destDir = "_public";
  console.log("Publishing to", destDir);
  let allPages = await space.listPages();
  const allPageMap: Map<string, any> = new Map(
    allPages.map((pm) => [pm.name, pm]),
  );

  console.log("Cleaning up destination directory");
  for (const attachment of await space.listAttachments()) {
    if (attachment.name.startsWith(destDir)) {
      await space.deleteAttachment(attachment.name);
    }
  }

  console.log(allPageMap);

  allPages = [...allPageMap.values()];
  let publishedPages = new Set<string>();
  if (publishConfig.publishAll) {
    publishedPages = new Set(allPages.map((p) => p.name));
  } else {
    for (const page of allPages) {
      if (publishConfig.tags && page.tags) {
        for (const tag of page.tags) {
          if (publishConfig.tags.includes(tag)) {
            publishedPages.add(page.name);
          }
        }
      }
      // Some sanity checking
      if (typeof page.name !== "string") {
        continue;
      }
      if (publishConfig.prefixes) {
        for (const prefix of publishConfig.prefixes) {
          if (page.name.startsWith(prefix)) {
            publishedPages.add(page.name);
          }
        }
      }

      if (page.$share) {
        if (!Array.isArray(page.$share)) {
          page.$share = [page.$share];
        }
        if (page.$share.includes("pub")) {
          publishedPages.add(page.name);
        }
      }
    }
  }
  console.log("Starting this thing", [...publishedPages]);

  let pageTemplate = await asset.readAsset("assets/template.hbs")!;
  if (publishConfig.template) {
    pageTemplate = (await readCodeBlockPage(publishConfig.template))!;
  }
  const template = Handlebars.compile(pageTemplate);

  const publishedPagesArray = [...publishedPages];
  for (const page of publishedPagesArray) {
    await generatePage(
      page,
      `${destDir}/${page}/index.html`,
      `${destDir}/${page}.md`,
      publishedPagesArray,
      publishConfig,
      destDir,
      template,
    );
  }

  if (publishConfig.indexPage) {
    console.log("Writing", publishConfig.indexPage);
    await generatePage(
      publishConfig.indexPage,
      `${destDir}/index.html`,
      `${destDir}/index.md`,
      publishedPagesArray,
      publishConfig,
      destDir,
      template,
    );
  }

  if (publishConfig.generateIndexJson) {
    console.log("Writing", `${destDir}/index.json`);
    const publishedFiles: FileMeta[] = [];
    for (
      const { name, size, contentType, lastModified } of await space
        .listAttachments()
    ) {
      if (name.startsWith(destDir)) {
        if (contentType === "text/html") {
          // Skip the generated HTML files
          continue;
        }
        publishedFiles.push({
          name: name.slice(destDir.length + 1),
          size,
          contentType,
          lastModified,
          perm: "ro",
        });
      }
    }
    await space.writeAttachment(
      `${destDir}/index.json`,
      new TextEncoder().encode(
        JSON.stringify(publishedFiles, null, 2),
      ),
    );
  }
}

export async function publishAllCommand() {
  await editor.flashNotification("Publishing...");
  await publishAll();
  await editor.flashNotification("Done!");
}

function collectAttachments(tree: ParseTree) {
  const attachments: string[] = [];
  collectNodesOfType(tree, "URL").forEach((node) => {
    const url = node.children![0].text!;
    if (url.indexOf("://") === -1) {
      attachments.push(url);
    }
  });
  return attachments;
}

function cleanMarkdown(
  mdTree: ParseTree,
  publishConfig: PublishConfig,
  validPages: string[],
): string {
  replaceNodesMatching(mdTree, (n) => {
    if (n.type === "WikiLink") {
      let page = n.children![1].children![0].text!;
      if (page.includes("@")) {
        page = page.split("@")[0];
      }
      if (!validPages.includes(page)) {
        // Replace with just page text
        return {
          text: `_${page}_`,
        };
      }
    }
    // Simply get rid of these
    if (n.type === "CommentBlock" || n.type === "Comment") {
      return null;
    }
    if (n.type === "Hashtag") {
      if (publishConfig.removeHashtags) {
        return null;
      }
    }
  });
  return renderToText(mdTree).trim();
}

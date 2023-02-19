import { compile } from "sass";
import postcss from "postcss";
import cssModules from "postcss-modules";
import { stat, readFile } from "fs/promises";
import path from "path";

import type { Plugin } from "esbuild";
import type { IClassModulesConfig } from "./index.d";
import type { ProcessOptions } from "postcss";

const cwd = process.cwd();
const pluginNamespace = "inqnuam-sass-ns"; // to coexist with other plugins

const globalCss = /\.global\.(s?css|sass)$/;
const importFrom = /(^|(\s*))import\s*((".*")|('.*'))/g;
const requireFrom = /.*require\s?\((\s*(\s*?".*"\s*?)|(\s*'.*'\s*?))\s*?\)/g;

interface IParsedFile {
  mtimeMs: number;
  globalImport: string[];
}
const parsedFiles: Map<string, IParsedFile> = new Map();

const importsForGlobalScope = async (importer: string, from: string) => {
  let isOutdatedContent = false;
  let isGlobalScoped = false;
  const { mtimeMs } = await stat(importer);
  const parsedFile = parsedFiles.get(importer);

  if (!parsedFile || mtimeMs > parsedFile.mtimeMs) {
    if (parsedFile) {
      isOutdatedContent = mtimeMs > parsedFile.mtimeMs;
    }
    const importerContent = await readFile(importer, { encoding: "utf-8" });

    const foundImports = importerContent.match(importFrom);
    const foundRequires = importerContent.match(requireFrom);

    let globalImport = [];
    if (foundImports) {
      globalImport = foundImports
        .map((x) => x.trim())
        .filter((x) => x && !x.startsWith("//"))
        .map(
          (x) =>
            x
              .split("import")
              .filter(Boolean)
              .map((x) => x.trim().replace(/"|'/g, ""))[0]
        )
        .filter(Boolean);
    }

    if (foundRequires) {
      const cleanedRequires = foundRequires
        .filter((x) => !x.includes("="))
        .map(
          (x) =>
            x
              .split("require")
              .filter(Boolean)
              .map((x) => x.replace(/\("|\('|'\)|"\)/g, ""))[0]
        )
        .filter(Boolean);

      globalImport = globalImport.concat(cleanedRequires);
    }
    parsedFiles.set(importer, { mtimeMs, globalImport });
    isGlobalScoped = globalImport.includes(from);
  } else {
    isGlobalScoped = parsedFile.globalImport.includes(from);
  }
  return {
    isOutdatedContent,
    isGlobalScoped,
  };
};

const defaultParams: IClassModulesConfig = {
  filter: /(\.modules?)?\.((s)?css|sass)$/i,
  options: {
    sass: {},
    postcss: [],
    cssModules: {
      globalModulePaths: [globalCss],
    },
  },
};

interface cacheContent {
  mtimeMs: number;
  value: string;
  pure: string;
  json: string;
  kind: string;
}

const cssBuilds: Map<string, cacheContent> = new Map();

const genContent = (path: string, json: string) => {
  let content = `
  import "${path}";
  export default ${json};
  `;

  return content;
};

const classModules = (config = defaultParams): Plugin => {
  const filter = config.filter ?? defaultParams.filter;
  const postcssPlugins = config.options?.postcss ?? [];
  const cssModulesOptions = config.options?.cssModules ?? defaultParams.options.cssModules;
  const customGetJON = cssModulesOptions.getJSON ?? ((cssFilename: string, json: any) => {});

  return {
    name: "inqnuam-sass-plugin",
    setup: (build) => {
      const sourceMap = build.initialOptions.sourcemap;
      build.onResolve({ filter: /^inqnuam-sass-ns/ }, (args) => {
        return {
          path: args.path,
          namespace: pluginNamespace,
        };
      });

      build.onResolve({ filter: filter }, async (args) => {
        if (args.namespace == pluginNamespace) {
          return;
        }

        let isGlobal = false;
        let isOutdated = false;
        if (args.importer) {
          const { isOutdatedContent, isGlobalScoped } = await importsForGlobalScope(args.importer, args.path);
          isOutdated = isOutdatedContent;
          isGlobal = isGlobalScoped;
        }

        let resolvePaths: string[] = [];

        if (args.path.startsWith("/")) {
          resolvePaths = [args.path];
        } else if (args.path.startsWith(".")) {
          resolvePaths = [args.resolveDir, args.path];
        } else {
          resolvePaths = [cwd, "node_modules", args.path];
        }

        const fileDir = path.resolve(...resolvePaths);

        return {
          path: fileDir,
          namespace: pluginNamespace,
          watchFiles: [fileDir],
          pluginData: {
            kind: args.kind,
            isGlobal,
            isOutdated,
          },
        };
      });

      build.onLoad({ filter: /^inqnuam-sass-ns/ }, (args) => {
        return {
          contents: cssBuilds.get(args.path).value,
          loader: "css",
        };
      });
      build.onLoad({ filter: /.*/, namespace: pluginNamespace }, async (args) => {
        const cachePath = `${pluginNamespace}:${args.path}`;

        let cached = cssBuilds.get(cachePath);
        const lastModifiedTime = (await stat(args.path)).mtimeMs;

        const isGlobal = args.pluginData.kind == "entry-point" || args.pluginData.isGlobal;
        if (args.pluginData.isOutdated || lastModifiedTime > cached?.mtimeMs) {
          cssBuilds.delete(cachePath);
          cached = null;
        }

        let pureCss = "";
        if (!cached) {
          let compilerOptions = {
            ...config.options?.sass,
            charset: false,
          };
          if (sourceMap) {
            compilerOptions.sourceMap = true;
            compilerOptions.sourceMapIncludeSources = true;
          }

          const result = compile(args.path, compilerOptions);

          pureCss = result.css;

          if (sourceMap) {
            const sm = JSON.stringify(result.sourceMap);
            const smBase64 = (Buffer.from(sm, "utf8") || "").toString("base64");
            const smComment = "/*# sourceMappingURL=data:application/json;charset=utf-8;base64," + smBase64 + " */";

            pureCss += "\n".repeat(2) + smComment;
          }

          let jsonContent = "";
          let css = "";

          let cssModulesOpt = {
            ...cssModulesOptions,
            getJSON(cssFilename, json) {
              jsonContent = JSON.stringify(json);
              customGetJON(cssFilename, json);
            },
          };

          if (isGlobal) {
            cssModulesOpt.scopeBehaviour = "global";
          }
          try {
            let postCssOpt: ProcessOptions = {
              from: args.path,
            };
            if (sourceMap) {
              postCssOpt.map = {
                inline: true,
              };
            }
            const { css: postCssGen } = await postcss([...postcssPlugins, cssModules(cssModulesOpt)]).process(pureCss, postCssOpt);

            css = postCssGen;
          } catch (error) {
            console.error(error);
          }

          let cssContent = css;

          cached = {
            mtimeMs: Date.now(),
            value: cssContent,
            pure: pureCss,
            json: jsonContent,
            kind: args.pluginData.kind,
          };
          cssBuilds.set(cachePath, cached);
        }

        if (isGlobal) {
          return {
            contents: cached.pure,
            loader: "css",
          };
        } else {
          return {
            contents: genContent(cachePath, cached.json),
            loader: "js",
          };
        }
      });
    },
  };
};

module.exports = classModules;

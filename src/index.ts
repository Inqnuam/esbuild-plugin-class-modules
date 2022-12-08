import { compile } from "sass";
import postcss from "postcss";
import cssModules from "postcss-modules";
import { stat, rm, readFile } from "fs/promises";
import path from "path";

import type { Plugin } from "esbuild";
import type { IClassModulesConfig } from "./index.d";

const cwd = process.cwd();
const pluginNamespace = "inqnuam-sass-ns"; // to coexist with other plugins

const javascript = /\.(m|c)?js$/;
const importers = /@import (url\(|").*;$/gm;
const fontFaces = /@font-face[^{]*{([^{}]|{[^{}]*})*}/gm;
const inputsFilter = /\.(m|c)?(j|t)sx?$/;
const emptyDeclaration = /[^{};\n\r]*{([^{}]|{[^{}]*})}/gm;
const globalCss = /\.global\.(s?css|sass)$/;
const importFrom = /(^|(\s*))import\s*((".*")|('.*'))/g;
const requireFrom = /.*require\s?\((\s*(\s*?".*"\s*?)|(\s*'.*'\s*?))\s*?\)/g;
// TODO: add control on more options
// add sourcemaps

const parsedFiles: Map<string, string[]> = new Map();

const importsForGlobalScope = async (importer: string, from: string) => {
  const parsedFile = parsedFiles.get(importer);

  if (parsedFile) {
    return parsedFile.includes(from);
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
  parsedFiles.set(importer, globalImport);
  return globalImport.includes(from);
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
  fonts: string[];
  imports: string[];
  kind: string;
}

const cssBuilds: Map<string, cacheContent> = new Map();

const classModules = (config = defaultParams): Plugin => {
  const filter = config.filter ?? defaultParams.filter;
  const postcssPlugins = config.options?.postcss ?? [];
  const cssModulesOptions = config.options.cssModules ?? defaultParams.options.cssModules;
  const customGetJON = cssModulesOptions.getJSON ?? ((cssFilename: string, json: any) => {});

  return {
    name: "inqnuam-sass-plugin",
    setup: (build) => {
      build.initialOptions.metafile = true;
      const minify = build.initialOptions.minify;

      build.onEnd(async (endRes) => {
        if (!cssBuilds.size) {
          return;
        }

        const outputs = endRes.metafile?.outputs;

        if (!outputs) {
          return;
        }

        const builders = async (o) => {
          const jsOutputPath = path.resolve(cwd, o);
          const parsedPath = path.parse(jsOutputPath);

          const cssFileName = parsedPath.name + ".css";
          const cssFilePath = `${parsedPath.dir}/${cssFileName}`;

          const { inputs } = outputs[o];

          const importclauses = Object.keys(inputs).filter((x) => inputsFilter.test(x));
          const entryPoints = Object.keys(inputs).filter((x) => x.startsWith(pluginNamespace) && cssBuilds.get(x)?.kind == "entry-point");

          const inputFiles = [];
          importclauses.forEach((x) => {
            const inlineImports = endRes.metafile.inputs[x]?.imports.filter((x) => x.path.startsWith(pluginNamespace)).map((x) => x.path);
            inputFiles.push(...inlineImports);
          });

          const cssFiles = Array.from(new Set(inputFiles))
            .map((x) => cssBuilds.get(x))
            .filter(Boolean);

          if (cssFiles.length) {
            const imports = Array.from(new Set(cssFiles.map((x) => x.imports?.join("\n")).filter(Boolean))).join("\n");
            const fonts = Array.from(new Set(cssFiles.map((x) => x.fonts?.join("\n")).filter(Boolean))).join("\n");

            let cssBanner = `@charset "UTF-8";`;

            if (imports) {
              cssBanner += `\n${imports}`;
            }

            if (fonts) {
              cssBanner += `\n${fonts}`;
            }

            await build.esbuild.build({
              stdin: {
                contents: cssFiles.map((x) => (x.kind == "entry-point" ? x.pure : x.value)).join("\n"),
                loader: "css",
              },
              banner: {
                css: cssBanner,
              },
              minify: minify,
              outfile: cssFilePath,
            });
          }

          if (entryPoints.length) {
            const foundEntryPointResult = cssBuilds.get(entryPoints[0]);

            if (foundEntryPointResult) {
              let cssBanner = `@charset "UTF-8";`;

              if (foundEntryPointResult.imports) {
                cssBanner += `\n${foundEntryPointResult.imports.join("\n")}`;
              }

              if (foundEntryPointResult.fonts) {
                cssBanner += `\n${foundEntryPointResult.fonts.join("\n")}`;
              }

              await build.esbuild.build({
                stdin: {
                  contents: foundEntryPointResult.pure,
                  loader: "css",
                },
                banner: {
                  css: cssBanner,
                },
                minify: minify,
                outfile: cssFilePath,
              });

              if (!cssModulesOptions.exportGlobals) {
                try {
                  await rm(jsOutputPath);
                } catch (error) {}
              }
            }
          }
        };

        const jsOutputs = Object.keys(outputs).filter((o) => javascript.test(o));

        await Promise.all(jsOutputs.map((o) => builders(o)));
      });

      build.onResolve({ filter: filter }, async (args) => {
        if (args.namespace == pluginNamespace) {
          return;
        }

        let isGlobal = false;
        if (args.importer) {
          isGlobal = await importsForGlobalScope(args.importer, args.path);
        }

        const resolvePaths = [];

        if (args.path.startsWith("@")) {
          resolvePaths.push(cwd, "node_modules");
        } else if (args.path.startsWith("node_modules")) {
          resolvePaths.push(cwd);
        } else {
          resolvePaths.push(args.resolveDir);
        }

        resolvePaths.push(args.path);
        const fileDir = path.resolve(...resolvePaths);

        return {
          path: fileDir,
          namespace: pluginNamespace,
          watchFiles: [fileDir],
          pluginData: {
            kind: args.kind,
            isGlobal,
          },
        };
      });

      build.onLoad({ filter: /.*/, namespace: pluginNamespace }, async (args) => {
        const cachePath = `${pluginNamespace}:${args.path}`;

        let cached = cssBuilds.get(cachePath);
        const lastModifiedTime = (await stat(args.path)).mtimeMs;

        const isGlobal = args.pluginData.kind == "entry-point" || args.pluginData.isGlobal;
        if (lastModifiedTime > cached?.mtimeMs) {
          cssBuilds.delete(cachePath);
          cached = null;
        }

        let pureCss = "";
        if (!cached) {
          const result = compile(args.path, { ...config.options.sass, charset: false });
          pureCss = result.css;

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
            const { css: postCssGen } = await postcss([...postcssPlugins, cssModules(cssModulesOpt)]).process(result.css, {
              from: args.path,
              map: false,
            });

            css = postCssGen;
          } catch (error) {
            console.error(error);
          }

          let cssContent = css;

          const imports = cssContent.match(importers);
          if (imports) {
            cssContent = cssContent.replace(importers, "");
          }

          const fonts = cssContent.match(fontFaces);
          if (fonts) {
            cssContent = cssContent.replace(fontFaces, "");
          }

          cached = {
            mtimeMs: Date.now(),
            value: cssContent,
            pure: pureCss,
            json: jsonContent,
            fonts: fonts?.map((f) => f.replace(/\s/g, "")),
            kind: args.pluginData.kind,
            imports,
          };
          cssBuilds.set(cachePath, cached);
        }

        return {
          contents: cached.json,
          loader: "json",
        };
      });
    },
  };
};

module.exports = classModules;

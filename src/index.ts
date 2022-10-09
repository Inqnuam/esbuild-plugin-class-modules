import { compile } from "sass";
import postcss from "postcss";
import cssModules from "postcss-modules";
import { stat } from "fs/promises";
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

// TODO: add control on more options
// add sourcemaps

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
  json: string;
  fonts: string[];
  imports: string[];
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
          const inputFiles = [];
          importclauses.forEach((x) => {
            inputFiles.push(...endRes.metafile.inputs[x]?.imports.filter((x) => x.path.startsWith(pluginNamespace)).map((x) => x.path));
          });

          const cssFiles = Array.from(new Set(inputFiles))
            .map((x) => cssBuilds.get(x))
            .filter(Boolean);

          if (cssFiles.length) {
            const imports = Array.from(new Set(cssFiles.map((x) => x.imports?.join("\n")).filter(Boolean))).join("\n");
            const fonts = Array.from(new Set(cssFiles.map((x) => x.fonts?.join("\n")).filter(Boolean))).join("\n");
            await build.esbuild.build({
              stdin: {
                contents: cssFiles.map((x) => x.value).join("\n"),
                loader: "css",
              },
              banner: {
                css: `@charset "UTF-8";\n${imports}\n${fonts}`,
              },
              minify: minify,
              outfile: cssFilePath,
            });
          }
        };

        const jsOutputs = Object.keys(outputs).filter((o) => javascript.test(o));

        await Promise.all(jsOutputs.map((o) => builders(o)));
      });

      build.onResolve({ filter: filter, namespace: "file" }, async (args) => {
        const fileDir = path.resolve(args.resolveDir, args.path);

        return {
          path: fileDir,
          namespace: pluginNamespace,
          watchFiles: [fileDir],
        };
      });

      build.onLoad({ filter: /.*/, namespace: pluginNamespace }, async (args) => {
        const cachePath = `${pluginNamespace}:${args.path}`;

        let cached = cssBuilds.get(cachePath);

        const lastModifiedTime = (await stat(args.path)).mtimeMs;

        if (lastModifiedTime > cached?.mtimeMs) {
          cssBuilds.delete(cachePath);
          cached = null;
        }

        if (!cached) {
          const result = compile(args.path, { ...config.options.sass, charset: false });

          let jsonContent = "";
          const { css } = await postcss([
            ...postcssPlugins,
            cssModules({
              ...cssModulesOptions,
              getJSON(cssFilename, json) {
                jsonContent = JSON.stringify(json);
                customGetJON(cssFilename, json);
              },
            }),
          ]).process(result.css, {
            from: args.path,
            map: false,
          });

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
            json: jsonContent,
            fonts: fonts?.map((f) => f.replace(/\s/g, "")),
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

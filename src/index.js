const sass = require("sass");
const postcss = require("postcss");
const cssModules = require("postcss-modules");
const { stat } = require("fs/promises");
const path = require("path");

const cwd = process.cwd();
const pluginNamespace = "inqnuam-sass-ns"; // to coexist with other plugins

const javascript = /\.(m|c)?js$/;

// TODO: add control on more options
// add sourcemaps
const defaultParams = {
  filter: /(\.modules?)?\.(s)?css$/i,
  options: {
    sass: {},
  },
};

const cssBuilds = new Map();

/**
 * @type {import('esbuild').Plugin}
 */
module.exports = (config = defaultParams) => {
  let filter = config.filter ?? defaultParams.filter;
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

          const cssContent = Object.keys(inputs)
            .filter((x) => filter.test(x))
            .map((x) => cssBuilds.get(x)?.value)
            .filter(Boolean)
            .join("\n");

          if (cssContent.length) {
            await build.esbuild.build({
              stdin: {
                contents: cssContent,
                loader: "css",
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
          const result = sass.compile(args.path, config.options.sass);

          let jsonContent = "";
          const { css } = await postcss([
            cssModules({
              getJSON(_, json) {
                jsonContent = JSON.stringify(json);
              },
            }),
          ]).process(result.css, {
            from: args.path,
            map: false,
          });

          cached = {
            mtimeMs: Date.now(),
            value: css,
            json: jsonContent,
          };
          cssBuilds.set(cachePath, { mtimeMs: Date.now(), value: css, json: jsonContent });
        }

        return {
          contents: cached.json,
          loader: "json",
        };
      });
    },
  };
};

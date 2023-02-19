import esbuild from "esbuild";

const shouldWatch = process.env.DEV == "true";

const ctx = await esbuild[shouldWatch ? "context" : "build"]({
  entryPoints: ["./src/index.ts"],
  platform: "node",
  format: "cjs",
  target: "ES6",
  bundle: true,
  minify: !shouldWatch,
  external: ["esbuild", "postcss", "postcss-modules", "sass"],
  outdir: "dist",
  plugins: [
    {
      name: "dummy",
      setup(build) {
        build.onEnd(() => {
          console.log("Compiler rebuild", new Date().toLocaleString());
        });
      },
    },
  ],
});

if (shouldWatch) {
  await ctx.watch();
}

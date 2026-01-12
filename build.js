const esbuild = require("esbuild");
const { gasPlugin } = require("esbuild-gas-plugin");

const build = async (esbuildModule = esbuild, plugin = gasPlugin) => {
  try {
    await esbuildModule.build({
      entryPoints: ["src/Code.js"],
      bundle: true,
      outfile: "dist/Code.gs",
      plugins: [plugin()],
    });
    console.log("Build successful");
    return true;
  } catch (err) {
    console.error("Build failed:", err);
    return false;
  }
};

const runIfMain = ({ main = require.main, current = module, buildFn = build } = {}) => {
  if (main === current) {
    buildFn();
  }
};

runIfMain();

module.exports = { build, runIfMain };

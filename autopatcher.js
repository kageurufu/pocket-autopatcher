import crypto from "crypto";
import path from "path";
import fs from "fs";
import fetch, { FetchError } from "node-fetch";
import readline from "readline";
import * as ips from "./ips.js";

// const RETROPATCHER_URL = "https://retropatcher.jonabrams.com"
const RETROPATCHER_URL =
  "https://raw.githubusercontent.com/JonAbrams/retropatcher/main/public";
const PATCHES_URL = "/patches/pocket.js";

const options = {
  romPath: path.resolve("./roms"),
  cacheDir: path.resolve("./.cache"),
  outputDir: path.resolve("./output"),
};

async function getPatches() {
  const cacheName = path.join(options.cacheDir, "pocket.js");
  const fp = await fs.promises.open(cacheName, "w");
  const res = await fetch(RETROPATCHER_URL + PATCHES_URL);
  await new Promise(async (resolve, reject) => {
    res.body.pipe(await fp.createWriteStream());
    res.body.on("end", () => resolve());
    res.body.on("error", (e) => reject(e));
  });
  await fp.close();

  return await import(cacheName);
}

async function downloadCached(downloadUrl) {
  if (downloadUrl.startsWith("/")) downloadUrl = RETROPATCHER_URL + downloadUrl;

  const url = new URL(downloadUrl);
  const cache_name = path.join(options.cacheDir, url.hostname, url.pathname);

  return await fs.promises.readFile(cache_name).catch(async (err) => {
    console.log(`Downloading ${url}`);
    await fs.promises.mkdir(path.dirname(cache_name), { recursive: true });

    const res = await fetch(url).then((resp) => {
      if (!resp.ok) {
        throw new FetchError(`${resp.status} ${url}: ${resp.statusText}`);
      }
      return resp;
    });

    await new Promise(async (resolve, reject) => {
      const fp = await fs.promises.open(cache_name, "w");

      res.body.pipe(await fp.createWriteStream());
      res.body.on("end", async () => {
        await fp.close();
        resolve();
      });
      res.body.on("error", async (e) => {
        await fp.close();
        reject(e);
      });
    }).catch(async (err) => {
      await fp.close();
      await fs.promises.deleteFile(cache_name);

      throw err;
    });

    return await fs.promises.readFile(cache_name);
  });
}

async function* walk(dirname) {
  for await (const d of await fs.promises.opendir(dirname)) {
    const entry = path.join(dirname, d.name);
    if (d.isDirectory()) {
      yield* walk(entry);
    } else if (d.isFile()) {
      yield entry;
    }
  }
}

function md5sum(data) {
  return crypto.createHash("md5").update(data).digest("hex");
}

async function catalogueRoms() {
  const catalogue_cache = path.join(options.cacheDir, "catalogue.json");
  const catalogue = {
    byHash: await fs.promises
      .readFile(catalogue_cache, "utf8")
      .then((text) => JSON.parse(text))
      .catch((err) => ({})),
  };
  catalogue.byName = Object.fromEntries(
    Object.entries(catalogue.byHash).map(([hash, name]) => [name, hash])
  );

  let count = 0;

  for await (const f of walk(options.romPath)) {
    if (count++ % 20 === 0) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      process.stdout.write(`${count} ${f}`);
    }

    if (/.gbc?$/.test(f) && !catalogue.byName[f]) {
      const md5 = md5sum(await fs.promises.readFile(f));
      catalogue.byHash[md5] = f;
      catalogue.byName[f] = md5;
    }
  }

  await fs.promises.writeFile(
    catalogue_cache,
    JSON.stringify(catalogue.byHash, null, 2)
  );

  readline.clearLine(process.stdout);
  return catalogue;
}

async function main() {
  const argv = process.argv.slice(2);
  while (argv.length) {
    const arg = argv.shift();
    switch (arg) {
      case "-o":
      case "--output":
        options.outputDir = path.resolve(argv.shift());
        break;

      case "-c":
      case "--cache":
        options.cacheDir = path.resolve(argv.shift());
        break;

      case "-r":
      case "--roms":
        options.romPath = path.resolve(argv.shift());
        break;

      case "-l":
      case "--log":
        options.logFile = path.resolve(argv.shift());
        break;

      default:
        console.log("Unknown option", arg);

      case "-h":
      case "--help":
        console.log(`Usage: ${process.argv[1]}
    -h, --help:      Show this help
    -o, --output:    Output directory
    -c, --cache:     Cache directory
    -r, --roms:      ROM directory
    -l, --log:       Write results to a log file`);
        process.exit(2);
    }
  }

  await fs.promises.mkdir(options.cacheDir, { recursive: true });
  await fs.promises.mkdir(options.outputDir, { recursive: true });

  let results = { missing: [], patched: [], failed: [], skipped: [] };

  let [catalogue, { updated, patches }] = await Promise.all([
    catalogueRoms(),
    getPatches(),
  ]);

  let maxPatchNameLength = patches.reduce(
    (max, { name }) => Math.max(max, name.length),
    0
  );
  for (const patch of patches) {
    const { name, md5, downloadUrl, extension = "pocket" } = patch;
    let localRom = catalogue.byHash[md5];

    if (!localRom) {
      console.log(`${name} (${md5}) not found in catalogue, skipping`);
      results.missing.push(patch);
      continue;
    }

    console.log(
      `Found ${name.padEnd(maxPatchNameLength, " ")} ${path.basename(localRom)}`
    );

    let patchData;
    try {
      patchData = await downloadCached(downloadUrl);
    } catch (e) {
      console.log("Error downloading patch", e);
      results.failed.push([patch, e]);
      continue;
    }

    const outfilename = path.join(options.outputDir, name + "." + extension);
    const fp = await fs.promises.open(outfilename, "wx").catch((err) => null);
    if (fp) {
      try {
        await fp.write(
          ips.applyPatch(await fs.promises.readFile(localRom), patchData)
        );
        console.log(`Wrote ${outfilename}`);
        results.patched.push(patch);
      } catch (err) {
        console.log(`Failed to patch ${name} (${md5}): ${err}`);
        results.failed.push([patch, err]);
      } finally {
        await fp.close();
      }
    } else {
      results.skipped.push(patch);
    }
  }

  if (options.logFile) {
    const fp = await fs.promises.open(options.logFile, "w");

    await fp.write(`autopatcher.js results\n`);
    await fp.write(`Patched: ${results.patched.length}\n`);
    await fp.write(`Missing: ${results.missing.length}\n`);
    await fp.write(`Skipped: ${results.skipped.length}\n`);
    await fp.write(`Failed: ${results.failed.length}\n`);

    await fp.write("\nFailed patches:\n");
    for (const [name, error] of results.failed) {
      await fp.write(`  ${name}: ${error}\n`);
    }

    await fp.write("\nPatched:\n");
    for (const name of results.patched) {
      await fp.write(`  ${name}\n`);
    }

    await fp.write("\nMissing:\n");
    for (const name of results.missing) {
      await fp.write(`  ${name}\n`);
    }

    await fp.write("\nSkipped patches:\n");
    for (const name of results.skipped) {
      await fp.write(`  ${name}\n`);
    }

    await fp.close();
  }
}

main();

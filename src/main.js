import { access, constants, mkdir, readdir, stat, rename } from 'node:fs/promises';
import { join } from 'node:path/posix';
import { argv, env } from 'node:process';

const VOLUME_SIZE_BYTES = 2_096_128; // TEST: 2 MiB - 1 KiB
let DIR_INPUTS = '';
let DIR_OUTPUT = '';

const confirmPathValidity = async (pathName) => {
        try {
                await access(pathName, constants.R_OK | constants.W_OK);
                await readdir(pathName, { recursive: true });
        } catch (err) {
                let errMessage = '';

                switch (err.code) {
                        case 'EACCES':
                                errMessage = `Unable to access path "${pathName}". Check your permissions.`;
                                break;
                        case 'ENOENT':
                        case 'ENOTDIR':
                                errMessage = `Unable to read from path "${pathName}". Path either does not exist or is not a directory.`;
                                break;
                        default:
                                errMessage = `Something went wrong.`;
                                break;
                }

                throw new Error(errMessage, { cause: err });
        }
};

const createWorkingDirectories = async (pathInput) => {
        const timestamp = Date.now();
        DIR_INPUTS = join(pathInput, `__00_inputs_${timestamp}`);
        DIR_OUTPUT = join(pathInput, `__00_output_${timestamp}`);

        await mkdir(DIR_INPUTS, { recursive: true });
        await mkdir(DIR_OUTPUT, { recursive: true });
};

const getDirSize = async (pathToDir) => {
        const dirContents = await readdir(pathToDir, { recursive: true, withFileTypes: true });
        let dirSizeBytes = 0;

        for await (const { parentPath, name } of dirContents) {
                const direntPath = join(parentPath, name);
                const direntStats = await stat(direntPath);
                dirSizeBytes += direntStats.size;
        }

        return dirSizeBytes;
};

const getZipEntries = async (pathInput) => {
        const dirents = await readdir(pathInput, { withFileTypes: true });
        const zipEntries = [];

        for await (const dirent of dirents) {
                const { parentPath, name } = dirent;
                const direntPath = join(parentPath, name);
                const direntSize = dirent.isDirectory()
                        ? await getDirSize(direntPath)
                        : (await stat(direntPath)).size;
                zipEntries.push({ parentPath, name, path: direntPath, size: direntSize });
        }

        return zipEntries;
};

const processZipEntries = async (zipEntries) => {
        for await (const { name, path, size } of zipEntries) {
                if (path === DIR_INPUTS || path === DIR_OUTPUT) continue;

                console.log(`Processing entry: "${name}"`);

                const archiveLocation = join(DIR_OUTPUT, name);
                const archiveName = join(archiveLocation, name);
                await mkdir(archiveLocation, { recursive: true });

                const cmd = ['7z', 'a', '-t7z', '-bso0', '-mx0'];
                if (env.ARCHIVE_PASS) cmd.push('-mhe', `-p${env.ARCHIVE_PASS}`);
                if (size > VOLUME_SIZE_BYTES) cmd.push(`-v${VOLUME_SIZE_BYTES}`);
                cmd.push(`${archiveName}.7z`, `${path}`);

                const proc = Bun.spawn(cmd);
                const exitCode = await proc.exited;

                console.log(`Entry processed with exit code ${exitCode}.\n`);

                await rename(path, join(DIR_INPUTS, name));
        }
};

const arrangeZipEntriesByParts = async () => {
        const entries = await readdir(DIR_OUTPUT, { withFileTypes: true });

        for await (const { parentPath, name } of entries) {
                const dirName = join(parentPath, name);
                const volumes = await readdir(dirName);
                volumes.sort();

                const parts = [];
                for (let i = 0; i < volumes.length; i += 10) parts.push(volumes.slice(i, i + 10));

                const cntParts = parts.length;
                const padLen = Math.floor(Math.log10(cntParts)) + 1;
                let partIdx = 0;

                for await (const partVolumes of parts) {
                        const strPartIdx = String(++partIdx).padStart(padLen, '0');
                        const suffix = ` [Part ${strPartIdx} of ${cntParts}]`;
                        const partDirName = join(dirName, name + suffix);
                        await mkdir(partDirName, { recursive: true });

                        for await (const vol of partVolumes)
                                await rename(join(dirName, vol), join(partDirName, vol));
                }
        }
};

const main = async () => {
        const pathInput = argv[2];
        await confirmPathValidity(pathInput);
        await createWorkingDirectories(pathInput);

        const zipEntries = await getZipEntries(pathInput);
        await processZipEntries(zipEntries);
        await arrangeZipEntriesByParts();

        console.log(`All entries processed.`);
};

await main();

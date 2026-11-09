import { access, constants, mkdir, readdir, stat, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path/posix';
import { argv } from 'node:process';
import { parseArgs } from 'node:util';

const HELP_TEXT = `

zip-dirs
usage: zipdirs [OPTIONS] DIR

Zip the contents of DIR (the current directory by default) into separate
archives using 7zip.

options:
    -p, --password PASS    set archive password to PASS (default: none)

    -s, --volume-size-bytes SIZE
                           set size of each volume to SIZE in bytes
                           (default: 2'146'435'072 = 2 GiB - 1 MiB)

    -x, --no-volumes       do not create volumes (default: false)
    -y, --yes              proceed without confirmation (default: false)
    -h, --help             display this help text and exit

example usage:
    zipdirs -s 1048576 "/home/user/docs"
        zip contents of directory "/home/user/docs" into new archives with
        volumes of size 1 MiB each.

`;

const VOLUME_SIZE_BYTES_DEFAULT = 2_146_435_072; // 2 GiB - 1 MiB
let VOLUME_SIZE_BYTES = VOLUME_SIZE_BYTES_DEFAULT;
let DIR_INPUTS = '';
let DIR_OUTPUT = '';

const parseCliArgs = () => {
        const argsProcessed = parseArgs({
                args: argv.slice(2),
                options: {
                        'help': { type: 'boolean', short: 'h' },
                        'yes': { type: 'boolean', short: 'y' },
                        'password': { type: 'string', short: 'p' },
                        'volume-size-bytes': { type: 'string', short: 's' },
                        'no-volumes': { type: 'boolean', short: 'x' },
                },
                strict: true,
                allowPositionals: true,
        });

        const { values, positionals } = argsProcessed;
        const dirInput = positionals[0] ?? dirname(argv[1]);
        const {
                help,
                password,
                yes,
                'volume-size-bytes': volumeSizeBytes,
                'no-volumes': noVolumes,
        } = values;

        if (help) {
                console.log(HELP_TEXT);
                process.exit(0);
        }

        return { dirInput, password, confirmOptions: yes, volumeSizeBytes, noVolumes };
};

const validateVolumeSize = (volumeSize) => {
        VOLUME_SIZE_BYTES = Number(volumeSize);

        if (!Number.isInteger(VOLUME_SIZE_BYTES)) {
                console.warn('\n[WARN] Volume size must be an integer, proceeding with default.');
                VOLUME_SIZE_BYTES = VOLUME_SIZE_BYTES_DEFAULT;
        }

        if (VOLUME_SIZE_BYTES <= 0) {
                console.warn('\n[WARN] Volume size must be positive, proceeding with default.');
                VOLUME_SIZE_BYTES = VOLUME_SIZE_BYTES_DEFAULT;
        }

        if (VOLUME_SIZE_BYTES > Number.MAX_SAFE_INTEGER) {
                console.warn('\n[WARN] Volume size too high, proceeding with default.');
                VOLUME_SIZE_BYTES = VOLUME_SIZE_BYTES_DEFAULT;
        }
};

const displaySelectedOptions = ({ confirmOptions, dirInput, password, noVolumes }) => {
        const strVolumeSize = new Intl.NumberFormat('en-US', {
                style: 'unit',
                unit: 'byte',
                unitDisplay: 'long',
        }).format(VOLUME_SIZE_BYTES);

        let promptMsg = `
Directory     : ${dirInput}
Password      : ${password || '[none]'}
Create Volumes: ${noVolumes ? 'No' : 'Yes'}`;

        if (!noVolumes) promptMsg += `\nVolume Size   : ${strVolumeSize}`;

        if (confirmOptions) {
                promptMsg += '\n\nProceeding with these options.';
                console.log(promptMsg);
                console.log();
        } else {
                promptMsg += '\n\nProceed with these options? (Y/n)';
                const response = prompt(promptMsg);
                const received = (response ?? 'y').trim().toLowerCase();
                console.log();

                if (received.startsWith('n') || received.startsWith('q')) {
                        console.log('Aborted. No changes made to file system.');
                        process.exit(0);
                }
        }
};

const getArchiveOptions = () => {
        const { dirInput, password, confirmOptions, volumeSizeBytes, noVolumes } = parseCliArgs();

        if (!dirInput) {
                console.log(HELP_TEXT);
                process.exit(0);
        }

        if (!noVolumes && volumeSizeBytes) validateVolumeSize(volumeSizeBytes);
        displaySelectedOptions({ confirmOptions, dirInput, password, noVolumes });

        return { dirInput, password, createVolumes: !noVolumes };
};

const confirmPathValidity = async (pathName) => {
        try {
                await access(pathName, constants.R_OK | constants.W_OK);
                await readdir(pathName, { recursive: true });
        } catch (err) {
                let errMessage = '';
                let logOriginalError = false;

                switch (err.code) {
                        case 'EACCES':
                                errMessage = `Unable to access path "${pathName}". Check your permissions.\n`;
                                break;
                        case 'ENOENT':
                        case 'ENOTDIR':
                                errMessage = `Unable to read from path "${pathName}". Path either does not exist or is not a directory.\n`;
                                break;
                        default:
                                errMessage = `Something went wrong.\n`;
                                logOriginalError = true;
                                break;
                }

                console.error(errMessage);
                if (logOriginalError) console.error(err);
                process.exit(1);
        }
};

const createWorkingDirectories = async (dirInput) => {
        const timestamp = Date.now();
        DIR_INPUTS = join(dirInput, `__00_inputs_${timestamp}`);
        DIR_OUTPUT = join(dirInput, `__00_output_${timestamp}`);

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

const getZipEntries = async (dirInput) => {
        const dirents = await readdir(dirInput, { withFileTypes: true });
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

const getHumanReadableSize = (sizeBytes) => {
        let size = sizeBytes;
        let unit = 'B';

        if (sizeBytes < 1024) {
                // pass
        } else if (sizeBytes < 1_048_576) {
                size >>= 10;
                unit = 'KiB';
        } else if (sizeBytes < 1_073_741_824) {
                size >>= 20;
                unit = 'MiB';
        } else {
                size = Math.floor(sizeBytes / 1_073_741_824);
                unit = 'GiB';
        }

        return `${size} ${unit}`;
};

const processZipEntries = async (zipEntries, config) => {
        const { password, createVolumes } = config;
        const cntEntries = zipEntries.length - 2;
        const padLen = Math.floor(Math.log10(cntEntries)) + 1;
        let entryIdx = 0;

        for await (const { name, path, size } of zipEntries) {
                if (path === DIR_INPUTS || path === DIR_OUTPUT) continue;

                const msgPrefix = `[${String(++entryIdx).padStart(padLen, '0')} of ${cntEntries}] `;
                const msgInfo = `Processing entry: "${name}" with size ${getHumanReadableSize(size)}`;
                console.log(msgPrefix + msgInfo);

                const archiveLocation = join(DIR_OUTPUT, name);
                const archiveName = `${join(archiveLocation, name)}.7z`;
                await mkdir(archiveLocation, { recursive: true });

                const cmd = ['7z', 'a', '-t7z', '-bso0', '-mx0'];
                if (password) cmd.push('-mhe', `-p${password}`);
                if (createVolumes && size > VOLUME_SIZE_BYTES) cmd.push(`-v${VOLUME_SIZE_BYTES}`);
                cmd.push(archiveName, path);

                const proc = Bun.spawn(cmd, { stdout: 'inherit' });
                const exitCode = await proc.exited;
                const processMsg = exitCode
                        ? `Unable to process entry, exit code ${exitCode}.\n`
                        : `Entry processed.\n`;
                console.log(processMsg);

                await rename(path, join(DIR_INPUTS, name));
        }
};

const arrangeOutputByParts = async () => {
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
        const { dirInput, password, createVolumes } = getArchiveOptions();
        await confirmPathValidity(dirInput);
        await createWorkingDirectories(dirInput);

        const zipEntries = await getZipEntries(dirInput);
        await processZipEntries(zipEntries, { password, createVolumes });
        await arrangeOutputByParts();

        console.log(`All entries processed. Archives are in "${DIR_OUTPUT}".`);
};

await main();

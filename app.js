import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { createWorker } from 'tesseract.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

const app = express();
const PORT = 3434;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* Where user uploads and examples will be stored */
const uploadsDirectory = path.join(__dirname, './uploads');
const examplesDirectory = path.join(__dirname, './examples');

/* Configure multer storage */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDirectory);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname); // keep original filename
  },
});
const upload = multer({ storage: storage });

/* Create the /uploads folder if it does not exist */
if (!fs.existsSync(uploadsDirectory)) fs.mkdirSync(uploadsDirectory);

/* Serve static files */
app.use('/uploads', express.static(uploadsDirectory));
app.use('/examples', express.static(examplesDirectory));
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
// app.get('/mcp.css', (req, res) => res.sendFile(path.join(__dirname, 'mvp.css')));

/* Store job data */
const jobs = {};

/* User uploads images to process */
app.post('/api/assets', upload.array('userFiles'), async (req, res) => {
  const images = req.files;
  const jobId = uuidv4();

  processJob(jobId, images, uploadsDirectory); // begin processing the images
  res.status(202).json({ images, jobId }); // tell the client the job is accepted
});

/* Choose 10 random files from the 'examples' folder to process */
app.get('/api/random', async (req, res) => {
  const files = await fs.promises.readdir(path.join(__dirname, './examples'));

  /* Fisher-Yates shuffle */
  let currIndex = files.length;
  while (currIndex !== 0) {
    const randIndex = Math.floor(Math.random() * currIndex);
    currIndex -= 1;
    [files[currIndex], files[randIndex]] = [files[randIndex], files[currIndex]];
  }
  const randomFiles = files.slice(0, 10);
  const images = randomFiles.map((e) => ({ filename: e }));
  const jobId = uuidv4();

  processJob(jobId, images, examplesDirectory); // begin processing the images
  res.status(202).json({ images, jobId }); // tell the client the job is accepted
});

/* Send back the job data */
app.get('/jobs/:id', (req, res) => {
  const jobId = req.params.id;
  res.json(jobs[jobId]);
});

/* Initialize jobs[jobId] with data that will be sent to the client */
const initializeJobData = (jobId, images) => {
  jobs[jobId] = images.reduce((acc, image) => {
    acc.push({
      filename: image.filename,
      status: 'processing', // 'processing' | 'done'
      text: null, // output from Tesseract OCR
      ocr_data: null, // output from Tesseract OCR
    });
    return acc;
  }, []);
};

/* Use Tesseract to perform Optical Character Recognition on each image in the job */
const processJob = (jobId, images, dir) => {
  initializeJobData(jobId, images);

  /* Use tesseract to extract text from each image */
  images.forEach(async (image, i) => {
    try {
      const worker = await createWorker();
      await worker.loadLanguage('eng');
      await worker.initialize('eng');

      const filepath = path.join(dir, image.filename);
      const {
        data: { text, tsv },
      } = await worker.recognize(filepath);

      /* The image has been processed, update status and data */
      const processedImage = jobs[jobId][i];
      processedImage.status = 'done';
      processedImage.text = text;
      processedImage.ocr_data = parseTSV(tsv);
      await worker.terminate();
    } catch (err) {
      const processedImage = jobs[jobId][i];
      processedImage.status = 'done';
      processedImage.error = { message: { err } };
      res.status(400).json({
        error: { message: 'Error during Tesseract processing: ', err },
      });
    }
  });
};

/* Transform the tab-separated-values output from Teseract into an object */
const parseTSV = (tsv) => {
  const data = tsv
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((e) => e[0] === '5'); // only care about level==='5' (words)
  return data.reduce((acc, e) => {
    acc.push({
      level: e[0],
      page_num: e[1],
      block_num: e[2],
      par_num: e[3],
      line_num: e[4],
      word_num: e[5],
      left: e[6],
      top: e[7],
      width: e[8],
      height: e[9],
      conf: e[10],
      text: e[11],
    });
    return acc;
  }, []);
};

/* Delete old files from /uploads folder */
const deleteOldFiles = async () => {
  const files = await fs.promises.readdir(uploadsDirectory);
  files.forEach(async (file) => {
    try {
      const filepath = uploadsDirectory + '/' + file;
      const stats = await fs.promises.stat(filepath);
      if (Date.now() - stats.mtimeMs > 1000 * 60 * 60 * 12) {
        await fs.promises.unlink(filepath);
        console.log(`Deleted ${file} from /uploads folder at ${new Date()}`);
      }
    } catch (err) {
      console.error(err);
    }
  });
  /* Recursively call this function every 10 minutes */
  setTimeout(deleteOldFiles, 1000 * 60 * 10);
};
deleteOldFiles();

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

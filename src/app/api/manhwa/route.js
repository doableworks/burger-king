import { OpenAI } from 'openai';
import { writeFile, unlink } from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';
import formidable from 'formidable';
import { Readable } from 'stream';
import { supabase } from '@/utils/superbase/client';
import axios from 'axios';
import fs from 'fs/promises';
import sharp from 'sharp'; // Import the sharp library for image processing
import Replicate from "replicate";
import promptData from "./prompts.json"
import { error } from 'console';

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});
let ErrorMsg = "";

function getFullPrompt(style, gender) {
    const styleData = promptData.styles.find(s => s[style]);
  
    if (styleData && styleData[style]) {
      const styleSpecificData = styleData[style];
      const prompt = styleSpecificData[gender.toLowerCase()];
      const background = styleSpecificData.backgrounds;
  
      if (prompt && background) {
        const randomPrompt = prompt[Math.floor(Math.random() * prompt.length)];
        const randomBackground = background[Math.floor(Math.random() * background.length)];
        return `${randomPrompt} Background: ${randomBackground}`;
      } else if (prompt) {
        return prompt[Math.floor(Math.random() * prompt.length)];
      } else if (background) {
        return `Background: ${background[Math.floor(Math.random() * background.length)]}`;
      } else {
        return "No prompts or backgrounds found for this style and gender.";
      }
    } else {
      return "Style not found.";
    }
  }

const BucketName = process.env.STORAGE_BUCKET;
const UserFileFolder = process.env.USER_FILE_FOLDER;
const OutputFileFolder = process.env.OUTPUT_FILE_FOLDER;
const TableName = process.env.TABLE_NAME;
const model = process.env.ModelName;
// const OpenAIApiKey = process.env.OPENAI_API_KEY;
// const OutputFileSize = process.env.OUTPUT_FILE_SIZE;
// const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4MB limit
// const PROMpT = process.env.PROMPT;

// Disable body parsing
export const config = {
    api: {
        bodyParser: false,
    },
};

async function generateImageBasedOnExisting(inputImagePath, userPrompt, outputImagePath) {
    try{
        const output = await replicate.run(
            model,
            {
              input: {
                  image: inputImagePath,
                  width: 1024,
                  height: 1024,
                  prompt: userPrompt,
                  scheduler: "KarrasDPM",
                  num_outputs: 1,
                  guidance_scale: 7.5,
                  apply_watermark: true,
                  negative_prompt: "worst quality, low quality",
                  prompt_strength: 0.8,
                  num_inference_steps: 60
                }
              }
            );
            console.log(output);
            for (const [index, item] of Object.entries(output)) {
              console.log(index,item);
              await writeFile(outputImagePath, item);
            }
            return outputImagePath;
    }
    catch(error)
    {
        ErrorMsg = error;
        return null;
    }
    
}

// Utility function for error responses
const createErrorResponse = (message, status = 500) => {
    console.error(`API Error: ${message}`);
    return NextResponse.json({ error: message }, { status });
};

// Convert Web Request to Node-style IncomingMessage
async function toNodeRequest(request) {
    const bodyArrayBuffer = await request.arrayBuffer();
    const bodyBuffer = Buffer.from(bodyArrayBuffer);
    const stream = Readable.from([bodyBuffer]);

    const req = Object.assign(stream, {
        headers: Object.fromEntries(request.headers),
        method: request.method,
        url: request.url,
    });

    return req;
}


async function insertUserData({ username, gender, userimageurl, outputimageurl }) {
    const { error } = await supabase.from(TableName).insert([
        {
            username,
            gender,
            userimageurl,
            outputimageurl,
        },
    ]);

    if (error) {
        console.error('Database Insert Error:', error);
        return false;
    }

    return true;
}

async function uploadImageToSupabase(buffer, filename) {
    const filePath = `${UserFileFolder}/${filename}`;

    const { data, error } = await supabase.storage
        .from(BucketName)
        .upload(filePath, buffer, {
            contentType: 'image/png', // Enforce PNG content type
        });

    if (error) {
        console.error('Supabase Storage Upload Error:', error);
        return null;
    }

    const { data: publicData } = supabase.storage
        .from(BucketName)
        .getPublicUrl(filePath);

    return publicData?.publicUrl || null;
}

async function uploadImageBufferToSupabase(buffer, filename) {
    const filePath = `${OutputFileFolder}/${filename}`;

    const { data, error } = await supabase.storage
        .from(BucketName)
        .upload(filePath, buffer, {
            contentType: 'image/png',
        });

    if (error) {
        console.error('Supabase Storage Buffer Upload Error:', error);
        return null;
    }

    const { data: publicData } = supabase.storage
        .from(BucketName)
        .getPublicUrl(filePath);

    return publicData?.publicUrl || null;
}

export async function POST(webRequest) {
    
    const req = await toNodeRequest(webRequest);
    const form = formidable({ multiples: false });

    return new Promise((resolve, reject) => {
        form.parse(req, async (err, fields, files) => {
            if (err) {
                console.error('Form Parsing Error:', err);
                return resolve(createErrorResponse('Failed to parse form data.'));
            }
            const username = fields.username?.[0];
            const gender = fields.gender?.[0];
            const imageFile = files.image?.[0];
            const style = fields.style?.[0];
            const userprompt = getFullPrompt(style,gender) || "Regenerate this image in Manhwa Style";

            if (!username || !gender || !imageFile || !userprompt) {
                return resolve(createErrorResponse('Missing required fields.'));
            }
            let userImageUrl = null;
            let processedImagePath = imageFile.filepath; // Start with the original path
            
            try {
                debugger;
                const imageBufferForUpload = await require('fs').promises.readFile(processedImagePath);
                const uploadFilename = `${username}-${Date.now()}-user.png`;
                userImageUrl = await uploadImageToSupabase(imageBufferForUpload, uploadFilename);
                if (!userImageUrl) {
                    return resolve(createErrorResponse('Failed to store user image in file server.'));
                }
                const outputpathurl = await generateImageBasedOnExisting(userImageUrl,userprompt,processedImagePath);
                if(outputpathurl == null){
                    return resolve(createErrorResponse('Failed to Generate image.'+ErrorMsg));
                }
                const imageBufferForUploadg = await require('fs').promises.readFile(outputpathurl);
                const uploadFilenameg = `${username}-${Date.now()}-generated.png`;
                const outputImageUrl = await uploadImageBufferToSupabase(imageBufferForUploadg, uploadFilenameg);
                await insertUserData({ username, gender, userimageurl: userImageUrl, outputimageurl: outputImageUrl });
                resolve(NextResponse.json({ url: outputImageUrl }));

            } catch (e) {
                debugger
                resolve(createErrorResponse(`Image processing failed: ${e.message || 'Unknown error'}`));
            } finally {
                if (imageFile?.filepath) {
                    try {
                        await unlink(imageFile.filepath);
                    } catch (unlinkErr) {
                        console.error('Error deleting original temporary file:', unlinkErr);
                    }
                }
                if (processedImagePath !== imageFile?.filepath && processedImagePath) {
                    try {
                        await unlink(processedImagePath);
                    } catch (unlinkErr) {
                        console.error('Error deleting converted temporary file:', unlinkErr);
                    }
                }
            }
        });
    });
}
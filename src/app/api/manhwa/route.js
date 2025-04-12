import { OpenAI } from 'openai'
import { writeFile, unlink } from 'fs/promises'
import path from 'path'
import { NextResponse } from 'next/server'
import formidable from 'formidable'
import { Readable } from 'stream'
import { supabase } from '@/utils/superbase/client'

const BucketName = process.env.STORAGE_BUCKET;
const UserFileFolder = process.env.USER_FILE_FOLDER;
const OutputFileFolder = process.env.OUTPUT_FILE_FOLDER;

// Disable body parsing
export const config = {
  api: {
    bodyParser: false,
  },
}

// Convert Web Request to Node-style IncomingMessage
async function toNodeRequest(request) {
  const bodyArrayBuffer = await request.arrayBuffer()
  const bodyBuffer = Buffer.from(bodyArrayBuffer) // ✅ Convert ArrayBuffer to Buffer
  const stream = Readable.from([bodyBuffer]) // ✅ Wrap in array to make it iterable

  const req = Object.assign(stream, {
    headers: Object.fromEntries(request.headers),
    method: request.method,
    url: request.url,
  })

  return req
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

async function insertUserData({ username, gender, userimageurl, outputimageurl }) {
  const { error } = await supabase.from(`${process.env.TABLE_NAME}`).insert([
    {
      username,
      gender,
      userimageurl,
      outputimageurl,
    },
  ])

  if (error) {
    console.error('Insert error:', error)
    return 'error'
  }

  return 'success'
}

async function uploadImage(file, userId) {
  const fileExt = file[0].originalFilename.split('.').pop()
  const fileName = `${userId}-${Date.now()}.${fileExt}`
  const filePath = `${UserFileFolder}/${fileName}`

  const { data, error } = await supabase.storage
    .from(`${BucketName}`) // your Supabase bucket name
    .upload(filePath, file)

  if (error) {
    console.error('Upload error:', error)
    return null
  }

  // Get public URL
  const { data: publicData } = supabase.storage
    .from(`${BucketName}`)
    .getPublicUrl(filePath)

  return publicData?.publicUrl || null
}

async function uploadImageBufferToSupabase(buffer, filename) {
  const filePath = `${OutputFileFolder}/${filename}`

  const { data, error } = await supabase.storage
    .from(`${BucketName}`)
    .upload(filePath, buffer, {
      contentType: 'image/png',
    })

  if (error) {
    console.error('Upload error:', error)
    return null
  }

  const { data: publicData } = supabase.storage
    .from(`${BucketName}`)
    .getPublicUrl(filePath)

  return publicData?.publicUrl || null
}




export async function POST(webRequest) {
    
  const req = await toNodeRequest(webRequest)

  const form = formidable({ multiples: false })

  return new Promise((resolve, reject) => {
    form.parse(req, async (err, fields, files) => {
      
      if (err) return reject(err)
      const username = fields.username[0];
      const gender = fields.gender[0];
      const image = files.image
      const tempPath = image[0].filepath
      const userImageUrl = await uploadImage(image, username);
      if(userImageUrl == null){
        reject(NextResponse.json({ url:null, error: 'Failed to store images in file server' }));
      }
      try {
        const result = await openai.images.edit({
          image: require('fs').createReadStream(tempPath),
          prompt:process.env.PROMPT,
          n: 1,
          size: process.env.OUTPUT_FILE_SIZE,
          response_format: 'url',
        })

        await unlink(tempPath)
        
        
        const imageResponse = await axios.get(outputImageUrl, {
          responseType: 'arraybuffer',
        })
        const imageBuffer = Buffer.from(imageResponse.data, 'binary')
        const fileName = `${username}-${Date.now()}-output.png`
        const uploadedOutputUrl = await uploadImageBufferToSupabase(imageBuffer, fileName)
        if(uploadedOutputUrl == null){
          reject(NextResponse.json({ url:null, error: 'Failed to store images in file server' }));
        }

        //insert into database
        const dbresult = await insertUserData({
          username: username,
          gender: gender,
          userimageurl: userImageUrl,
          outputimageurl: uploadedOutputUrl,
        })
        if(dbresult == 'error'){
          reject(NextResponse.json({ url:null, error: 'Failed to save user information in database' }));
        }else if(dbresult == 'success'){
          resolve(NextResponse.json({ url: result.data[0].url }))
        }else{
          reject(NextResponse.json({ url:null, error: 'something went wrong' }));
        }
      } catch (e) {
        debugger;
        reject(NextResponse.json({ url:null, error: 'Failed to generate image' }))
      }
    })
  })
}

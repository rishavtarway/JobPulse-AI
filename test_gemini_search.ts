import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

async function test() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    tools: [
      {
        //@ts-ignore
        googleSearch: {}
      }
    ]
  });

  const response = await model.generateContent("Who won the super bowl in 2025?");
  console.log(response.response.text());
}

test().catch(console.error);

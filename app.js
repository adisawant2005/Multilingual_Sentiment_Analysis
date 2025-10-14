import express, { response } from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import csvParser from 'csv-parser';

dotenv.config();

const app = express();
app.use(express.json());

const START_INDEX = 0; // Starting index for sampling rows from CSV
const MAX_ROWS = 100; // Maximum number of rows to sample from CSV

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Function to parse CSV file
async function parseCsv(filePath, startingIndex = 0, maxRows = 1000) {
  if (!fs.existsSync(filePath)) {
    throw new Error('CSV file not found.');
  }

  const rows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (row) => rows.push(row))
      .on('end', resolve)
      .on('error', reject);
  });

  if (rows.length === 0) {
    throw new Error('CSV file is empty.');
  }

  const endIndex = Math.min(startingIndex + maxRows, rows.length);
  const sampleRows = rows.slice(startingIndex, endIndex);
  return { rows, sampleRows };
}

// Function to estimate tokens
function estimateTokens(compactCsv) {
  return Math.ceil(compactCsv.length / 4) + 500;
}

// Function to handle errors
function handleError(res, error) {
  console.error('Error during CSV analysis:', error);
  if (error.code === 'ENOENT') {
    res.status(404).json({ error: 'India.csv file not found.' });
  } else if (error.message.includes('token count exceeds')) {
    res.status(400).json({ error: 'Input too large for model. Try a smaller CSV or increase sampling limit.' });
  } else if (error.status === 400 && error.message.includes('response_schema')) {
    res.status(400).json({ error: 'Schema validation failed—check config.', details: error.message });
  } else {
    res.status(500).json({ error: 'Failed to process CSV file with Gemini API.', details: error.message });
  }
}

// Function to translate text using Gemini
async function translateText(text, targetLanguage) {
  if (!text || text.length === 0 || targetLanguage.toLowerCase() === 'english') {
    return text;
  }
  
  // Note: Using a minimal prompt here for brevity. Use the robust one from previous context for production.
  const prompt = `Translate the following text into ${targetLanguage}. Return ONLY the translated text. Text to translate: ${text}`;

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ parts: [{ text: prompt }] }],
      config: { temperature: 0.1 },
    });
    return result.text.trim();
  } catch (error) {
    console.error("Translation API error:", error);
    return text;
  }
}


// Route for general chat
app.get('/gemini', async (req, res) => {
  try {
    const query = req.query.query;
    if (!query) {
      return res.status(400).json({ error: 'Please provide a query' });
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          parts: [{ text: query }],
        },
      ],
    });
    res.json({ text: response.text });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});


// Define a route to trigger the analysis of the local CSV file
app.get('/count-sentiment-india-csv', async (req, res) => {
  try {
    const csvFilePath = './India.csv';
    const { rows, sampleRows } = await parseCsv(csvFilePath, START_INDEX, MAX_ROWS);

    const prompt = [
      {
        parts: [
          {
            text: `Here is sampled data from India.csv (full dataset has ${rows.length} rows):

${sampleRows.map((row) => Object.values(row).join(',')).join('\n')}

Count the number of positive, negative, and neutral tweets in the dataset and return the result in the following JSON format:

{
  "positive": 0,
  "negative": 0,
  "neutral": 0,
  "positive_percent": 0.0,
  "negative_percent": 0.0,
  "neutral_percent": 0.0
}`,
          },
        ],
      },
    ];

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            positive: {
              type: 'number',
              description: 'Number of positive tweets.',
            },
            negative: {
              type: 'number',
              description: 'Number of negative tweets.',
            },
            neutral: {
              type: 'number',
              description: 'Number of neutral tweets.',
            },
            positive_percent: {
              type: 'number',
              description: 'Percentage of positive tweets.',
            },
            negative_percent: {
              type: 'number',
              description: 'Percentage of negative tweets.',
            },
            neutral_percent: {
              type: 'number',
              description: 'Percentage of neutral tweets.',
            },
          },
          required: ['positive', 'negative', 'neutral', 'positive_percent', 'negative_percent', 'neutral_percent'],
          additionalProperties: false,
        },
      },
    });

    const responseText = result.text;
    console.log('Raw response from Gemini:', responseText); // Debug log

    if (!responseText) {
      return res.status(500).json({
        error: 'Gemini returned empty response.',
        result: JSON.stringify(result, null, 2),
      });
    }

    let sentimentCounts;
    try {
      sentimentCounts = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse JSON response:', responseText);
      return res.status(500).json({
        error: 'Gemini returned invalid JSON format.',
        geminiResponse: responseText,
        parseError: parseError.message,
      });
    }

    res.json(sentimentCounts);
  } catch (error) {
    handleError(res, error);
  }
});


/**
 * Express endpoint to analyze the sentiment of 100 sampled tweets 
 * from India.csv using a 5-point scale and a Diplomat persona.
 */
app.get('/analyze-multiple-tweets-sentiment', async (req, res) => {
    try {
        const csvFilePath = './India.csv';
        
        // 1. Load the data, getting 100 sample rows (tweets)
        // Ensure that rows are objects { id: '...', tweet: '...' }
        const { rows, sampleRows } = await parseCsv(csvFilePath, START_INDEX, MAX_ROWS);

        // Prepare the text data string for the prompt
        const tweetDataString = sampleRows.map(row => 
            // Using assumed object keys. Adjust indices (row[0], row[6]) if object keys aren't used.
            `ID: ${row.id || row[0]} | TEXT: ${row.tweet || row[6]}`
        ).join('\n');
        
        const totalSampledTweets = sampleRows.length;

        // 2. Construct the PROMPT with the 5-point scale and strict rules
        const prompt = [
            {
                parts: [
                    {
                        text: `**Role:** You are a **proud Indian diplomat** and a multilingual sentiment analysis expert. Your classification must reflect an informed, nuanced perspective focused on **national interest, cultural pride, and constructive commentary**.

Analyze the sentiment for each of the ${totalSampledTweets} tweets provided below, regardless of the language.

**Classification Rules (5-Point Scale):** You must classify the sentiment using a numerical score from 1 to 5.

- **5 (STRONGLY POSITIVE):** Clear excitement, strong support, emphatic praise, or clear national pride/celebration.
- **4 (SLIGHTLY POSITIVE):** Expresses mild approval, light optimism, satisfaction, or a subtle celebration.
- **3 (NEUTRAL/FACTUAL):** **USE SPARINGLY.** Only classify as 3 if the tweet is purely **factual reporting** (e.g., an announcement, a non-opinionated link share) AND contains absolutely no implied or expressed opinion.
- **2 (SLIGHTLY NEGATIVE):** Expresses mild concern, constructive criticism, or minor dissatisfaction.
- **1 (STRONGLY NEGATIVE):** Clear outrage, strong condemnation, significant fear, or deep pessimism.

Return ONLY a single JSON object containing an array of results. The output must adhere strictly to the provided JSON Schema.

Tweet Data (ID | TEXT):
---
${tweetDataString}
---`,
                    },
                ],
            },
        ];

        // 3. Define the CORRECTED Structured Output Schema
        const multiSentimentSchema = {
            type: 'object',
            properties: {
                sentiments: {
                    type: 'array',
                    description: `A list of ${totalSampledTweets} sentiment score results.`,
                    // FIX IS HERE: The array 'items' must be a valid schema for an object
                    items: { 
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'The original ID of the tweet.' },
                            sentiment_score: { 
                                type: 'integer', // Numerical score 1-5
                                description: 'The classified sentiment score (1=Strongly Negative, 5=Strongly Positive).',
                                minimum: 1, 
                                maximum: 5  
                            },
                        },
                        required: ['id', 'sentiment_score']
                    },
                },
            },
            required: ['sentiments'],
            additionalProperties: false,
        };


        // 4. Call the Gemini API
        const result = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                temperature: 0.1, 
                responseMimeType: 'application/json',
                responseSchema: multiSentimentSchema, // Use the corrected schema
            },
        });

        // 5. Parse and return the results
        const responseText = result.text;
        
        if (!responseText) {
            return res.status(500).json({ error: 'Gemini returned empty response.' });
        }

        let sentimentResults;
        try {
            sentimentResults = JSON.parse(responseText);
        } catch (parseError) {
            // Handle cases where the model might still produce malformed JSON
            console.error('Failed to parse JSON response:', responseText, parseError);
            return res.status(500).json({
                error: 'Gemini returned invalid JSON format. Check raw output.',
                geminiResponse: responseText
            });
        }

        res.json({
            count: totalSampledTweets,
            ...sentimentResults 
        });

    } catch (error) {
        handleError(res, error);
    }
});


// Define a route to trigger the trend analysis of the local CSV file
app.get('/analyze-trends-india-csv', async (req, res) => {
    try {
        // Get the requested translation language from the query parameter
        const targetLanguage = req.query.lang;
        
        const csvFilePath = './India.csv';
        // Ensure parseCsv is available and correctly implemented
        const { rows, sampleRows } = await parseCsv(csvFilePath, START_INDEX, MAX_ROWS);

        // --- 1. Define the CORRECTED JSON structure for the prompt ---
        // We are aiming for a list of objects, not a list of quoted strings.
        const analysisPrompt = [
            {
                parts: [
                    {
                        text: `Analyze the trends in the following tweeter CSV data:

${sampleRows.map((row) => Object.values(row).join(',')).join('\n')}

Identify 2-3 significant trends. Return the trends with their description in ENGLISH ONLY in the following JSON format:

{
  "trends": [
    { "title": "Trend Title 1", "description": "Detailed description of the first trend." },
    { "title": "Trend Title 2", "description": "Detailed description of the second trend." }
  ]
}`,
                    },
                ],
            },
        ];

        // --- 2. Define the CORRECTED JSON Schema ---
        const analysisResponseSchema = {
            type: 'object',
            properties: {
                trends: {
                    type: 'array',
                    description: 'A list of key trends identified in the data.',
                    items: {
                        type: 'object',
                        properties: {
                            title: { type: 'string', description: 'A concise title for the trend.' },
                            description: { type: 'string', description: 'A detailed explanation of the trend.' },
                        },
                        required: ['title', 'description']
                    },
                },
            },
            required: ['trends'],
        };

        // --- 3. Call the Gemini API for Analysis ---
        const result = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: analysisPrompt,
            config: {
                temperature: 0.1,
                responseMimeType: 'application/json',
                responseSchema: analysisResponseSchema,
            },
        });

        const responseText = result.text;
        // Parse the JSON response from the model
        let trendsResult = JSON.parse(responseText);

        // --- 4. Optional: Translate the results if a targetLanguage is provided ---
        if (targetLanguage && targetLanguage.toLowerCase() !== 'english') {
            const translatedTrends = [];
            
            // Loop through each trend object
            for (const trend of trendsResult.trends) {
                const translatedTitle = await translateText(trend.title, targetLanguage);
                const translatedDescription = await translateText(trend.description, targetLanguage);
                
                translatedTrends.push({
                    title: translatedTitle,
                    description: translatedDescription
                });
            }
            // Replace the English trends with the translated ones
            trendsResult.trends = translatedTrends;
        }

        // --- 5. Send the final response ---
        res.json(trendsResult);
    } catch (error) {
        console.error('Error in /analyze-trends-india-csv:', error);
        res.status(500).json({ message: 'Internal Server Error', error: error.message });
    }
});


// Define a route to trigger the insight generation of the local CSV file
app.get('/generate-insights-india-csv', async (req, res) => {
  try {
    const csvFilePath = './India.csv';
    const { rows, sampleRows } = await parseCsv(csvFilePath, START_INDEX, MAX_ROWS);
    const lang = req.query.lang || 'english';

    const prompt = [
      {
        parts: [
          {
            text: `Generate insights from the following tweeter CSV data:

${sampleRows.map((row) => Object.values(row).join(',')).join('\n')}

Return the insights in the following JSON format:

{
  "insights": ["Insight 1: Notable trend or observation.", "Insight 2: Any shift in data or unusual pattern."]
}`,
          },
        ],
      },
    ];

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            insights: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
        },
      },
    });

    const responseText = result.text;
    const insights = JSON.parse(responseText).insights;

    if (lang.toLowerCase() !== 'english') {
      const translatedInsights = await Promise.all(insights.map((insight) => translateText(insight, lang)));
      res.json({ insights: translatedInsights });
    } else {
      res.json({ insights });
    }
  } catch (error) {
    handleError(res, error);
  }
});


// Define a route to trigger the summary generation of the local CSV file
app.get('/generate-summary-india-csv', async (req, res) => {
  try {
    const csvFilePath = './India.csv';
    const { rows, sampleRows } = await parseCsv(csvFilePath, START_INDEX, MAX_ROWS);
    const lang = req.query.lang || 'english';

    const prompt = [
      {
        parts: [
          {
            text: `Generate a short summary of the key findings from the following tweeter CSV data:

${sampleRows.map((row) => Object.values(row).join(',')).join('\n')}

Return the summary in the following JSON format:

{
  "summary": "Short overall summary of key findings from the data."
}`,
          },
        ],
      },
    ];

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
            },
          },
        },
      },
    });

    const responseText = result.text;
    const summary = JSON.parse(responseText).summary;

    if (lang.toLowerCase() !== 'english') {
      const translatedSummary = await translateText(summary, lang);
      res.json({ summary: translatedSummary });
    } else {
      res.json({ summary });
    }
  } catch (error) {
    handleError(res, error);
  }
});


// Update the welcome route to include the new endpoint
app.get('/', (req, res) => {
  res.send('<h1>Gemini API Demo</h1><p>Visit <a href="/gemini">/gemini</a> for a quick chat or <a href="/count-sentiment-india-csv">/count-sentiment-india-csv</a> to get the sentiment counts or <a href="/generate-insights-india-csv">/generate-insights-india-csv</a> to get insights or <a href="/generate-summary-india-csv">/generate-summary-india-csv</a> to get summary.</p>');
});


export default app;
# Lock In

> A Chrome extension for staying focused while studying and working.

**Lock In** is a simple website blocker that helps you stay focused on your study.

Unlike traditional website blockers, Lock In can analyze the **content** of YouTube videos and Reddit posts to determine whether they are relevant to your current task. This allows it to block distracting content even when it comes from otherwise useful websites.

## ✨ Features

* 🚫 **Website blocking** — block distracting websites while you work or study.
* 🎯 **Task-based blocking** — define what you are currently working on and use it as the basis for content filtering.
* ▶️ **YouTube and Reddit content filtering** — block videos and posts that are not relevant to your current task using local AI model.

## Task formulation:

For the most efficiency, formulate goals in custom option in a form "learn *X*", where *X* is subject.
Do not write too specific subjects
The options are not limited to the programming, math and english. See the list of goals the model learned at the bottom

https://github.com/user-attachments/assets/42377d43-b102-41df-8174-cbf1da902fc5

## 🚀 Installation

1. Clone the repository:

```bash
git clone https://github.com/Pann1ka/Lock-In.git
cd Lock-In
```

2. Download `model.onnx` from [Hugging Face](https://huggingface.co/nsagatov1/youtube-video-relevance-classifier).

3. Place the downloaded model here:

```text
models/
└── youtube-video-relevance-classifier/
    └── onnx/
        └── model.onnx
```

4. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**.

5. Select the extension directory.

## 🔑 YouTube Data API

Lock In uses the **YouTube Data API v3** to retrieve information about YouTube videos.

To use YouTube-related features:

1. Create a Google Cloud project and enable **YouTube Data API v3**.
2. Create an API key.
3. Add your API key to `config.js`:

```javascript
const YOUTUBE_API_KEY = "YOUR_API_KEY";
```

See Google's [YouTube Data API documentation](https://developers.google.com/youtube/v3) for setup instructions.


## 🤝 Contributing

Bug reports, feature requests, and contributions are welcome.

## 📄 License

MIT

### List of goals the model learned on:

 - Languages: Chinese, English, French, German, Italian, Spanish
 - Science: biology, chemistry, mathematics, physics
 - Courses: computer science, chemical engineernig, electrical engineering, civil engineering, mechanical engineering 
 - Machine learning

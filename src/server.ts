import express from "express";
import {job1, job2, job3, job4} from "../../../cron_job/src/cron_job";
import dotenv from "dotenv";
import mongoose from "mongoose";

const app = express();
const port = 8000;

app.get("/", (req, res) => {
    res.send("Hello, World!");
});

console.log("Cron job started")
console.log("Cron job 1 started")
job1.start();
console.log("Cron job 2 started")
job2.start();
console.log("Cron job 3 started")
job3.start();
console.log("Cron job 4 started")
job4.start();

dotenv.config();

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_DB_URI || 'http://localhost:8080', {dbName: process.env.MONGO_DATABASE});
        console.log('MongoDB connected successfully');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
};

connectDB()

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
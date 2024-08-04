import {CronJob} from 'cron';
import {queue} from 'async';
import {WebPDFLoader} from "@langchain/community/document_loaders/web/pdf";
import axios from "axios";
import mongoose, {Schema, Document, Model} from 'mongoose';
import OpenAI from "openai";
import dotenv from "dotenv";
import qs from 'qs';

dotenv.config();

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY as string
})

interface IPosition extends Document {
    position: string;
    status: string;
    date: Date;
}


interface IUser extends Document {
    firstName: string;
    lastName: string;
    email: string;
    password?: string;
    positions?: IPosition[];
    profileImage: string
    isVerified?: boolean;
    isHr?: boolean;
    linkedinId?: string;
    hasHHAccount?: boolean;
    hhAccessToken?: string;
    hhRefreshToken?: string;

    hasLinkedinAccount?: boolean;
    linkedinAccessToken?: string;
    linkedinRefreshToken?: string;

    only_with_salary?: boolean;

    createdAt?: Date;
    updatedAt?: Date;

    comparePassword(candidatePassword: string): Promise<boolean>;
}

const PositionSchema: Schema<IPosition> = new mongoose.Schema<IPosition>({
    position: {type: String, required: true},
    status: {type: String, default: 'Active'},
    date: {type: Date, required: true, default: Date.now},
});

const UserSchema: Schema<IUser> = new mongoose.Schema<IUser>(
    {
        email: {
            type: String,
            required: true,
            unique: true,
            match: [/^\S+@\S+\.\S+$/, 'Please use a valid email address.']
        },
        firstName: {type: String, required: true},
        lastName: {type: String, required: true},
        password: {type: String},
        profileImage: {type: String},
        positions: {type: [PositionSchema], default: []},
        hasHHAccount: {type: Boolean, default: false},
        hhAccessToken: {type: String, default: ''},
        hhRefreshToken: {type: String, default: ''},
        hasLinkedinAccount: {type: Boolean, default: false},
        linkedinId: {type: String, default: ''},
        linkedinAccessToken: {type: String, default: ''},
        linkedinRefreshToken: {type: String, default: ''},
        only_with_salary: {type: Boolean, default: false},
        isVerified: {type: Boolean, default: false},
        isHr: {type: Boolean, default: false}
    },
    {
        timestamps: true,
    }
);

const UserModel: Model<IUser> = mongoose.model<IUser>('User', UserSchema);

export interface IVacancy extends Document {
    vacancy_id: string;
    job_name: string;
    employer_name: string;
    salary: number;
    employer_logo: string;
    responsibility: string;
    requirement: string;
    address: string;
    url: string;
    user: string;
    cover_letter: string;
    isHeadHunterVacancy: boolean;
    isOtherSiteVacancy: boolean;
}

const VacancySchema: Schema = new Schema({
    vacancy_id: {type: String, required: true},
    job_name: {type: String, required: true},
    employer_name: {type: String, required: true},
    salary: {type: Number},
    employer_logo: {type: String},
    responsibility: {type: String},
    requirement: {type: String, required: true},
    address: {type: String},
    url: {type: String, required: true},
    user: {type: String, ref: 'User', required: true},
    cover_letter: {type: String, required: true},
    isHeadHunterVacancy: {type: Boolean, default: false},
    isOtherSiteVacancy: {type: Boolean, default: false}
});

const VacanciesModel = mongoose.model<IVacancy>('Vacancy', VacancySchema);


async function loadPDF(url: string, token?: string) {
    if (!token) {
        const response = await fetch(url);
        const data = await response.blob();
        const loader = new WebPDFLoader(data);
        const pdfData = await loader.load();
        return pdfData.map(page => JSON.stringify(page)).join(' ');
    }
    const response = await fetch(url, {headers: {authorization: `Bearer ${token}`}});
    const data = await response.blob();
    const loader = new WebPDFLoader(data);

    const pdfData = await loader.load();
    return pdfData.map(page => JSON.stringify(page)).join(' ');
}


interface TokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in: number;
}

class HHService {
    authorization = async (code: string): Promise<any> => {
        try {
            const URL = 'https://hh.ru/oauth/token';
            const params = new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: process.env.HH_CLIENT_ID || '',
                client_secret: process.env.HH_SECRET_KEY || '',
                code: code
            });
            const response = await axios.post(URL, params.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            return this.extractTokens(response);
        } catch (err) {
            console.error("Failed to sign in");
        }
    }
    sendNegotiation = async (vacancyId: string, resumeId: string, message: string, token: string): Promise<any> => {
        try {
            const URL = 'https://api.hh.ru/negotiations';
            const formData = new FormData();
            formData.append('vacancy_id', vacancyId);
            formData.append('resume_id', resumeId);
            if (message) {
                formData.append('message', message);
            }

            const response = await axios.post(URL, formData, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'multipart/form-data',
                    'HH-User-Agent': 'Recruiter AI/1.0 (arystambekdimash005@gmail.com)'
                }
            });

            return response.data;
        } catch (err) {
            if (axios.isAxiosError(err)) {
                if (err.response) {
                    console.error('Error response data:', err.response.data);
                    console.error('Error response status:', err.response.status);
                    console.error('Error response headers:', err.response.headers);
                } else if (err.request) {
                    console.error('Error request:', err.request);
                } else {
                    console.error('Error message:', err.message);
                }
            } else {
                console.error('Unexpected error:', err);
            }

            return {success: false, message: 'An error occurred, but the operation has continued.'};
        }
    };

    getVacancy = async (vacancyName: any, paramsObj: any) => {
        try {
            const URL = 'https://api.hh.ru/vacancies';
            const today = new Date();

            const twoDaysAgo = new Date(today);
            twoDaysAgo.setDate(today.getDate() - 2);

            paramsObj.date_from = twoDaysAgo.toISOString().split('T')[0];
            paramsObj.order_by = 'publication_time';
            paramsObj.text = vacancyName;
            paramsObj.area = 40

            const params = new URLSearchParams(paramsObj);

            const response = await axios.get(`${URL}?${params.toString()}`);
            return response.data;
        } catch (err: any) {
            if (err.response) {
                console.error("Response data:", err.response.data);
                console.error("Response status:", err.response.status);
                console.error("Response headers:", err.response.headers);
            } else {
                console.error("Error message:", err.message);
            }
            throw err;
        }
    }
    getSuitableResumeId = async (vacancyId: string, token: string): Promise<any> => {
        try {
            const resumesURL = `https://api.hh.ru/vacancies/${vacancyId}/suitable_resumes`;
            const vacancyURL = `https://api.hh.ru/vacancies/${vacancyId}`;

            const resumeResponse = await axios.get(resumesURL, {
                headers: this.getHeaders(token)
            });
            const vacancyResponse = await axios.get(vacancyURL, {
                headers: this.getHeaders(token)
            });

            const resumes = resumeResponse.data.items.slice(0, 4);
            const vacancy = vacancyResponse.data;

            const resumeDetails = await Promise.all(resumes.map(async (resume: any) => {
                const pdfContent = await loadPDF(resume.download.pdf.url, token);
                return {
                    id: resume.id,
                    data: pdfContent
                };
            }));

            const vacancyDetails = `
            Vacancy for ${vacancy.name}, located in ${vacancy.area.name}.
            Salary: ${vacancy.salary?.from} to ${vacancy.salary?.to} ${vacancy.salary?.currency}.
            Employment type: ${vacancy.employment.name}, Schedule: ${vacancy.schedule.name}.
            Key skills required: ${vacancy.key_skills.map((skill: any) => skill.name).join(', ')}.
        `;

            const PROMPT = `
            Get the most suitable resume id. WARNING : If there is no suitable resume id, then get any existing resume id.
            Resumes:
            ${resumeDetails.map((resume: any) => `
                Resume ID: ${resume.id}
                Resume data: ${resume.data}
            `).join('\n')}
       
            Vacancy:
            ${vacancyDetails}
            
            Return in this format:
            {
                "resumeId": "string" | null
            }
        `;
            const completion = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [{role: "user", content: PROMPT}],
                temperature: 0.3
            });

            const jsonResponse = completion.choices[0].message.content as string;

            const regex = /"resumeId": "([^"]+)"/;
            const match = jsonResponse.match(regex);

            if (match && match[1]) {
                return match[1];
            } else {
                const response = await axios.get('https://api.hh.ru/resumes/mine', {
                    headers: this.getHeaders(token)
                });
                return response.data.items[0].id;
            }
        } catch (err) {
            if (axios.isAxiosError(err)) {
                if (err.response) {
                    console.error('Response data:', err.response.data);
                    console.error('Status code:', err.response.status);
                    console.error('Headers:', err.response.headers);
                } else if (err.request) {
                    console.error('Request data:', err.request);
                } else {
                    console.error('Error message:', err.message);
                }
            } else {
                console.error('Unexpected error:', err);
            }
        }
    }
    getOneResume = async (resumeId: string, token: string) => {
        const URL = `https://api.hh.ru/resumes/${resumeId}`
        const response = await axios.get(`${URL}`, {
            headers: this.getHeaders(token)
        });
        return response.data;

    }

    refreshAccessToken = async (user: IUser) => {
        const URL = `https://hh.ru/token`;
        try {
            const data = qs.stringify({
                refresh_token: user.hhRefreshToken,
                grant_type: "refresh_token"
            });

            const response = await axios.post(URL, data, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'HH-User-Agent': 'Recruiter AI/1.0 (arystambekdimash005@gmail.com)'
                }
            });

            user.hhAccessToken = response.data.access_token;
            user.hhRefreshToken = response.data.refresh_token;
            await user.save();
        } catch (err) {
            console.error('Error message:', err);
        }
    }

    extractTokens(response: any): TokenResponse {
        return {
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token,
            expires_in: response.data.expires_in
        };
    }

    getHeaders(token: string): { [key: string]: string } {
        return {
            'Authorization': `Bearer ${token}`,
            'HH-User-Agent': 'Recruiter AI/1.0 (arystambekdimash005@gmail.com)'
        };
    }
}


const hhService = new HHService();

const getApplicationsPerPosition = (numPositions: number): number => {
    if (numPositions <= 4) return 7;
    if (numPositions >= 8) return 2;
    return 6;
};

const generateCoverLetter = async (user: any, vacancy: any, resume: any = '') => {
    let COVER_LETTER_PROMPT = '';
    try {
        COVER_LETTER_PROMPT = `
    Твоя задача — создать профессиональное сопроводительное письмо.
    Адресуйте письмо следующему указанную должность:
    Должность: ${vacancy.name}
    Опишите, как ваше образование, опыт работы, навыки и мотивация соответствуют требованиям и задачам должности. Используйте следующую информацию:
    Требования: ${vacancy.snippet.requirement}
    Задачи: ${vacancy.snippet.responsibility}
    Пишите в профессиональном, лаконичном и сжатом тоне. Сопроводительное письмо должно быть на языке вакансии. Не добавляйте лишние пробелы или символы.
    Имя: ${user.firstName}
    Фамилия: ${user.lastName}
    Резюме: ${resume}
    Пример сопроводительного письма:
    Здравствуйте, Я пишу, чтобы выразить свою заинтересованность в должности ${vacancy.name} в компании ${vacancy.employer.name}. 
    Уверен, что мои навыки и опыт делают меня сильным кандидатом на эту роль. Благодаря проактивному подходу, исключительной 
    трудовой этике и решимости превосходить цели, я уверен в своей способности успешно выполнять обязанности данной должности.
    У меня более [время(если есть если нет не надо врать)] опыта в [соответствующей области/должности]. В моей предыдущей роли в [предыдущий работодатель] я 
    [кратко опишите ключевые достижения и обязанности, связанные с работой].
    Кроме того, у меня есть опыт работы с [соответствующее программное обеспечение/инструменты/навыки].
    Я с нетерпением жду возможности обсудить, как мой опыт, навыки и энтузиазм могут способствовать успеху.
    Спасибо за рассмотрение моей заявки. Надеюсь на возможность обсудить мои квалификации подробнее.
    Попробуйте писать 50-60 слов и всегда начинай на Здравствуйте.
    
    
    И Важно если у меня в резюме нет подходящего навыка или опыта работы или я сам тебе не сказал не пиши про это. Пиший правильный нормальный сопровождательный письмо 
    Никого не обманывай
  `;
    } catch (err) {
        console.log(err)
    }
    try {
        const completion = await openai.chat.completions.create({
            messages: [{role: 'user', content: COVER_LETTER_PROMPT}],
            model: 'gpt-4o-mini',
            temperature: 0.3
        });

        return completion.choices[0].message.content;
    } catch (error) {
        console.error('Error generating cover letter:', error);
        return null;
    }
};

const isSuitableVacancy = async (position: string, vacancy: any): Promise<boolean> => {
    const vacancyDetails = `
    Vacancy Title: ${vacancy.name}, Vacancy Responsibility: ${vacancy.snippet.responsibility}, Vacancy Requirements: ${vacancy.snippet.requirement}.
    Salary: ${vacancy.salary?.from} to ${vacancy.salary?.to} ${vacancy.salary?.currency}.
  `;
    const PROMPT = `Analyze if the vacancy is suitable for the user's request. 
    User's requested position: ${position} \n Vacancy Details: ${vacancyDetails} \n
    Return in this format: 
{
"isSuitable": boolean,
"reason": "string"
}
    This format is required
    WARNING: Vacancy should be max suitable and if not suitable is suitable is false`;

    try {
        const completion = await openai.chat.completions.create({
            messages: [{role: 'user', content: PROMPT}],
            model: 'gpt-4o-mini',
            temperature: 0.3
        });

        const responseText: any = completion.choices[0].message.content;
        const responseJson = JSON.parse(responseText);
        return responseJson.isSuitable;
    } catch (error) {
        console.error('Error determining if vacancy is suitable:', error);
        return false;
    }
};

const processVacancies = async (user: any, position: { position: string; status: string }) => {
    if (!user.positions) return;

    const applicationsPerPosition = getApplicationsPerPosition(user.positions.length);
    const vacancyDocs: any[] = [];
    let processedVacancies = 0;
    for (let page = 1; page <= 6; page++) {
        const PROMPT = `
        Я буду давать тебе positions как это (это просто экзампл) Python developer с зарплатой меньше 350000тг и ты должен извелечь
        позицию как (это просто экзампл) Python developer
        
        и еще постоянно извелечь ключевой слово это нужно для поиска по вакансям как это просто экзампл Javascript разработчик или т.д
        и извелечь без уровней только позицию
        
        user wanted position text: ${position.position} 
        
        {"position" : "string"}
      `;
        try {
            const completion = await openai.chat.completions.create({
                messages: [{role: 'user', content: PROMPT}],
                model: 'gpt-4o-mini',
                temperature: 0.3
            });
            const responseText: any = completion.choices[0].message.content;
            const responseJson = JSON.parse(responseText);
            const extractPosition = responseJson.position;
            console.log(extractPosition)
            const vacanciesPage = await hhService.getVacancy(extractPosition, {
                page,
                text: extractPosition,
                only_with_salary: user.only_with_salary,
            });
            if (vacanciesPage.items.length === 0) {
                continue;
            }
            const promises = vacanciesPage.items.map(async (vacancy: any) => {
                if (processedVacancies >= applicationsPerPosition) {
                    return;
                }
                const alreadyInVacancyDocs = vacancyDocs.some((doc: any) => doc.vacancy_id === vacancy.id || (doc.job_name === vacancy.name && doc.employer_name === vacancy.employer.name) || (doc.job_name === vacancy.name));
                if (alreadyInVacancyDocs) {
                    return;
                }
                const alreadyExistingVacancy = await VacanciesModel.findOne({user: user.id, job_name: vacancy.name});
                if (alreadyExistingVacancy) {
                    return;
                }
                const isSuitable = await isSuitableVacancy(position.position, vacancy);
                if (!isSuitable) return;

                let coverLetter: any;
                if (user.hasHHAccount) {
                    const resumeId = await hhService.getSuitableResumeId(vacancy.id, user.hhAccessToken as string);
                    const resumeDetail = await hhService.getOneResume(resumeId, user.hhAccessToken as string);
                    const pdfContent = await loadPDF(resumeDetail.download.pdf.url, user.hhAccessToken);
                    coverLetter = await generateCoverLetter(user, vacancy, pdfContent);
                    await hhService.sendNegotiation(vacancy.id, resumeId, coverLetter, user.hhAccessToken as string);
                } else {
                    coverLetter = await generateCoverLetter(user, vacancy);
                    if (!coverLetter) {
                        return;
                    }
                }

                const vacancyDoc = {
                    vacancy_id: vacancy.id,
                    job_name: vacancy.name,
                    employer_name: vacancy.employer.name,
                    salary: vacancy.salary ? vacancy.salary.from : 0,
                    employer_logo: vacancy.employer.logo_urls ? vacancy.employer.logo_urls['90'] : 'https://media.licdn.com/dms/image/C4D0BAQGYJfURzon1xg/company-logo_200_200/0/1631327285447?e=2147483647&v=beta&t=mTBfWh3AsArQHLJLo8fp6OLk5LLlzqQrsL6ob3uUFsA',
                    responsibility: vacancy.snippet.responsibility || '',
                    requirement: vacancy.snippet.requirement || '',
                    address: vacancy.address ? vacancy.address.raw : '',
                    url: `https://hh.kz/vacancy/${vacancy.id}/`,
                    user: user._id,
                    cover_letter: coverLetter,
                    isHeadHunterVacancy: true,
                    isOtherSiteVacancy: false,
                };
                vacancyDocs.push(vacancyDoc);
                processedVacancies++;
            });

            await Promise.allSettled(promises);

            if (processedVacancies >= applicationsPerPosition) break;
        } catch (error) {
            console.error('Error processing vacancies for page', page, error);
        }
    }

    if (vacancyDocs.length > 0) {
        try {
            await VacanciesModel.insertMany(vacancyDocs, {ordered: false});
            console.log('Vacancies inserted successfully');
        } catch (error) {
            console.error('Error inserting vacancies:', error);
        }
    } else {
        console.log('No vacancies to insert');
    }
};

const processUsers = async (users: any[]) => {
    const q = queue(async (user: any, callback) => {
        await hhService.refreshAccessToken(user)
        const positionPromises = user.positions.map(async (position: any) => {
            if (position.position && position.status === 'Active') {
                await processVacancies(user, position);
            }
        });
        await Promise.allSettled(positionPromises);
        callback();
    }, 10);

    users.forEach(user => q.push(user));
    await q.drain();
};

const autoApply = async () => {
    try {
        console.log('Task started');
        const users: any[] = await UserModel.find({}).lean();
        console.log(users)
        await processUsers(users);
        console.log('Task ended');
    } catch (error) {
        console.error('Error during auto apply process:', error);
    }
};

export const job1 = new CronJob('0 */2 * * *', autoApply, null, true, 'Asia/Qyzylorda');

// Schedule the job to run at 3:00 PM
// export const job2 = new CronJob('0 15 * * *', autoApply, null, true, 'Asia/Qyzylorda');
//
// // Schedule the job to run at 6:00 PM
// export const job3 = new CronJob('0 18 * * *', autoApply, null, true, 'Asia/Qyzylorda');
//
// // Schedule the job to run at 11:59 PM
// export const job4 = new CronJob('59 23 * * *', autoApply, null, true, 'Asia/Qyzylorda');

// export const test = new CronJob('*/5 * * * *', autoApply, null, true, 'Asia/Qyzylorda');


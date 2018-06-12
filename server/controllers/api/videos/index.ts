import * as express from 'express'
import { extname, join } from 'path'
import { VideoCreate, VideoPrivacy, VideoState, VideoUpdate } from '../../../../shared'
import { renamePromise } from '../../../helpers/core-utils'
import { retryTransactionWrapper } from '../../../helpers/database-utils'
import { getVideoFileResolution } from '../../../helpers/ffmpeg-utils'
import { processImage } from '../../../helpers/image-utils'
import { logger } from '../../../helpers/logger'
import { getFormattedObjects, getServerActor, resetSequelizeInstance } from '../../../helpers/utils'
import {
  CONFIG,
  IMAGE_MIMETYPE_EXT,
  PREVIEWS_SIZE,
  sequelizeTypescript,
  THUMBNAILS_SIZE,
  VIDEO_CATEGORIES,
  VIDEO_LANGUAGES,
  VIDEO_LICENCES,
  VIDEO_MIMETYPE_EXT,
  VIDEO_PRIVACIES
} from '../../../initializers'
import {
  changeVideoChannelShare,
  federateVideoIfNeeded,
  fetchRemoteVideoDescription,
  getVideoActivityPubUrl
} from '../../../lib/activitypub'
import { sendCreateView } from '../../../lib/activitypub/send'
import { JobQueue } from '../../../lib/job-queue'
import { Redis } from '../../../lib/redis'
import {
  asyncMiddleware,
  authenticate,
  optionalAuthenticate,
  paginationValidator,
  setDefaultPagination,
  setDefaultSort,
  videosAddValidator,
  videosGetValidator,
  videosRemoveValidator,
  videosSearchValidator,
  videosSortValidator,
  videosUpdateValidator
} from '../../../middlewares'
import { TagModel } from '../../../models/video/tag'
import { VideoModel } from '../../../models/video/video'
import { VideoFileModel } from '../../../models/video/video-file'
import { abuseVideoRouter } from './abuse'
import { blacklistRouter } from './blacklist'
import { videoCommentRouter } from './comment'
import { rateVideoRouter } from './rate'
import { VideoFilter } from '../../../../shared/models/videos/video-query.type'
import { VideoSortField } from '../../../../client/src/app/shared/video/sort-field.type'
import { createReqFiles, isNSFWHidden } from '../../../helpers/express-utils'

const videosRouter = express.Router()

const reqVideoFileAdd = createReqFiles(
  [ 'videofile', 'thumbnailfile', 'previewfile' ],
  Object.assign({}, VIDEO_MIMETYPE_EXT, IMAGE_MIMETYPE_EXT),
  {
    videofile: CONFIG.STORAGE.VIDEOS_DIR,
    thumbnailfile: CONFIG.STORAGE.THUMBNAILS_DIR,
    previewfile: CONFIG.STORAGE.PREVIEWS_DIR
  }
)
const reqVideoFileUpdate = createReqFiles(
  [ 'thumbnailfile', 'previewfile' ],
  IMAGE_MIMETYPE_EXT,
  {
    thumbnailfile: CONFIG.STORAGE.THUMBNAILS_DIR,
    previewfile: CONFIG.STORAGE.PREVIEWS_DIR
  }
)

videosRouter.use('/', abuseVideoRouter)
videosRouter.use('/', blacklistRouter)
videosRouter.use('/', rateVideoRouter)
videosRouter.use('/', videoCommentRouter)

videosRouter.get('/categories', listVideoCategories)
videosRouter.get('/licences', listVideoLicences)
videosRouter.get('/languages', listVideoLanguages)
videosRouter.get('/privacies', listVideoPrivacies)

videosRouter.get('/',
  paginationValidator,
  videosSortValidator,
  setDefaultSort,
  setDefaultPagination,
  optionalAuthenticate,
  asyncMiddleware(listVideos)
)
videosRouter.get('/search',
  videosSearchValidator,
  paginationValidator,
  videosSortValidator,
  setDefaultSort,
  setDefaultPagination,
  optionalAuthenticate,
  asyncMiddleware(searchVideos)
)
videosRouter.put('/:id',
  authenticate,
  reqVideoFileUpdate,
  asyncMiddleware(videosUpdateValidator),
  asyncMiddleware(updateVideoRetryWrapper)
)
videosRouter.post('/upload',
  authenticate,
  reqVideoFileAdd,
  asyncMiddleware(videosAddValidator),
  asyncMiddleware(addVideoRetryWrapper)
)

videosRouter.get('/:id/description',
  asyncMiddleware(videosGetValidator),
  asyncMiddleware(getVideoDescription)
)
videosRouter.get('/:id',
  asyncMiddleware(videosGetValidator),
  getVideo
)
videosRouter.post('/:id/views',
  asyncMiddleware(videosGetValidator),
  asyncMiddleware(viewVideo)
)

videosRouter.delete('/:id',
  authenticate,
  asyncMiddleware(videosRemoveValidator),
  asyncMiddleware(removeVideoRetryWrapper)
)

// ---------------------------------------------------------------------------

export {
  videosRouter
}

// ---------------------------------------------------------------------------

function listVideoCategories (req: express.Request, res: express.Response) {
  res.json(VIDEO_CATEGORIES)
}

function listVideoLicences (req: express.Request, res: express.Response) {
  res.json(VIDEO_LICENCES)
}

function listVideoLanguages (req: express.Request, res: express.Response) {
  res.json(VIDEO_LANGUAGES)
}

function listVideoPrivacies (req: express.Request, res: express.Response) {
  res.json(VIDEO_PRIVACIES)
}

// Wrapper to video add that retry the function if there is a database error
// We need this because we run the transaction in SERIALIZABLE isolation that can fail
async function addVideoRetryWrapper (req: express.Request, res: express.Response, next: express.NextFunction) {
  const options = {
    arguments: [ req, res, req.files['videofile'][0] ],
    errorMessage: 'Cannot insert the video with many retries.'
  }

  const video = await retryTransactionWrapper(addVideo, options)

  res.json({
    video: {
      id: video.id,
      uuid: video.uuid
    }
  }).end()
}

async function addVideo (req: express.Request, res: express.Response, videoPhysicalFile: Express.Multer.File) {
  const videoInfo: VideoCreate = req.body

  // Prepare data so we don't block the transaction
  const videoData = {
    name: videoInfo.name,
    remote: false,
    extname: extname(videoPhysicalFile.filename),
    category: videoInfo.category,
    licence: videoInfo.licence,
    language: videoInfo.language,
    commentsEnabled: videoInfo.commentsEnabled || false,
    waitTranscoding: videoInfo.waitTranscoding || false,
    state: CONFIG.TRANSCODING.ENABLED ? VideoState.TO_TRANSCODE : VideoState.PUBLISHED,
    nsfw: videoInfo.nsfw || false,
    description: videoInfo.description,
    support: videoInfo.support,
    privacy: videoInfo.privacy,
    duration: videoPhysicalFile['duration'], // duration was added by a previous middleware
    channelId: res.locals.videoChannel.id
  }
  const video = new VideoModel(videoData)
  video.url = getVideoActivityPubUrl(video) // We use the UUID, so set the URL after building the object

  // Build the file object
  const { videoFileResolution } = await getVideoFileResolution(videoPhysicalFile.path)
  const videoFileData = {
    extname: extname(videoPhysicalFile.filename),
    resolution: videoFileResolution,
    size: videoPhysicalFile.size
  }
  const videoFile = new VideoFileModel(videoFileData)

  // Move physical file
  const videoDir = CONFIG.STORAGE.VIDEOS_DIR
  const destination = join(videoDir, video.getVideoFilename(videoFile))
  await renamePromise(videoPhysicalFile.path, destination)
  // This is important in case if there is another attempt in the retry process
  videoPhysicalFile.filename = video.getVideoFilename(videoFile)
  videoPhysicalFile.path = destination

  // Process thumbnail or create it from the video
  const thumbnailField = req.files['thumbnailfile']
  if (thumbnailField) {
    const thumbnailPhysicalFile = thumbnailField[0]
    await processImage(thumbnailPhysicalFile, join(CONFIG.STORAGE.THUMBNAILS_DIR, video.getThumbnailName()), THUMBNAILS_SIZE)
  } else {
    await video.createThumbnail(videoFile)
  }

  // Process preview or create it from the video
  const previewField = req.files['previewfile']
  if (previewField) {
    const previewPhysicalFile = previewField[0]
    await processImage(previewPhysicalFile, join(CONFIG.STORAGE.PREVIEWS_DIR, video.getPreviewName()), PREVIEWS_SIZE)
  } else {
    await video.createPreview(videoFile)
  }

  // Create the torrent file
  await video.createTorrentAndSetInfoHash(videoFile)

  const videoCreated = await sequelizeTypescript.transaction(async t => {
    const sequelizeOptions = { transaction: t }

    const videoCreated = await video.save(sequelizeOptions)
    // Do not forget to add video channel information to the created video
    videoCreated.VideoChannel = res.locals.videoChannel

    videoFile.videoId = video.id
    await videoFile.save(sequelizeOptions)

    video.VideoFiles = [ videoFile ]

    if (videoInfo.tags !== undefined) {
      const tagInstances = await TagModel.findOrCreateTags(videoInfo.tags, t)

      await video.$set('Tags', tagInstances, sequelizeOptions)
      video.Tags = tagInstances
    }

    await federateVideoIfNeeded(video, true, t)

    logger.info('Video with name %s and uuid %s created.', videoInfo.name, videoCreated.uuid)

    return videoCreated
  })

  if (video.state === VideoState.TO_TRANSCODE) {
    // Put uuid because we don't have id auto incremented for now
    const dataInput = {
      videoUUID: videoCreated.uuid,
      isNewVideo: true
    }

    await JobQueue.Instance.createJob({ type: 'video-file', payload: dataInput })
  }

  return videoCreated
}

async function updateVideoRetryWrapper (req: express.Request, res: express.Response, next: express.NextFunction) {
  const options = {
    arguments: [ req, res ],
    errorMessage: 'Cannot update the video with many retries.'
  }

  await retryTransactionWrapper(updateVideo, options)

  return res.type('json').status(204).end()
}

async function updateVideo (req: express.Request, res: express.Response) {
  const videoInstance: VideoModel = res.locals.video
  const videoFieldsSave = videoInstance.toJSON()
  const videoInfoToUpdate: VideoUpdate = req.body
  const wasPrivateVideo = videoInstance.privacy === VideoPrivacy.PRIVATE

  // Process thumbnail or create it from the video
  if (req.files && req.files['thumbnailfile']) {
    const thumbnailPhysicalFile = req.files['thumbnailfile'][0]
    await processImage(thumbnailPhysicalFile, join(CONFIG.STORAGE.THUMBNAILS_DIR, videoInstance.getThumbnailName()), THUMBNAILS_SIZE)
  }

  // Process preview or create it from the video
  if (req.files && req.files['previewfile']) {
    const previewPhysicalFile = req.files['previewfile'][0]
    await processImage(previewPhysicalFile, join(CONFIG.STORAGE.PREVIEWS_DIR, videoInstance.getPreviewName()), PREVIEWS_SIZE)
  }

  try {
    await sequelizeTypescript.transaction(async t => {
      const sequelizeOptions = {
        transaction: t
      }
      const oldVideoChannel = videoInstance.VideoChannel

      if (videoInfoToUpdate.name !== undefined) videoInstance.set('name', videoInfoToUpdate.name)
      if (videoInfoToUpdate.category !== undefined) videoInstance.set('category', videoInfoToUpdate.category)
      if (videoInfoToUpdate.licence !== undefined) videoInstance.set('licence', videoInfoToUpdate.licence)
      if (videoInfoToUpdate.language !== undefined) videoInstance.set('language', videoInfoToUpdate.language)
      if (videoInfoToUpdate.nsfw !== undefined) videoInstance.set('nsfw', videoInfoToUpdate.nsfw)
      if (videoInfoToUpdate.waitTranscoding !== undefined) videoInstance.set('waitTranscoding', videoInfoToUpdate.waitTranscoding)
      if (videoInfoToUpdate.support !== undefined) videoInstance.set('support', videoInfoToUpdate.support)
      if (videoInfoToUpdate.description !== undefined) videoInstance.set('description', videoInfoToUpdate.description)
      if (videoInfoToUpdate.commentsEnabled !== undefined) videoInstance.set('commentsEnabled', videoInfoToUpdate.commentsEnabled)
      if (videoInfoToUpdate.privacy !== undefined) {
        const newPrivacy = parseInt(videoInfoToUpdate.privacy.toString(), 10)
        videoInstance.set('privacy', newPrivacy)

        if (wasPrivateVideo === true && newPrivacy !== VideoPrivacy.PRIVATE) {
          videoInstance.set('publishedAt', new Date())
        }
      }

      const videoInstanceUpdated = await videoInstance.save(sequelizeOptions)

      // Video tags update?
      if (videoInfoToUpdate.tags !== undefined) {
        const tagInstances = await TagModel.findOrCreateTags(videoInfoToUpdate.tags, t)

        await videoInstanceUpdated.$set('Tags', tagInstances, sequelizeOptions)
        videoInstanceUpdated.Tags = tagInstances
      }

      // Video channel update?
      if (res.locals.videoChannel && videoInstanceUpdated.channelId !== res.locals.videoChannel.id) {
        await videoInstanceUpdated.$set('VideoChannel', res.locals.videoChannel, { transaction: t })
        videoInstanceUpdated.VideoChannel = res.locals.videoChannel

        if (wasPrivateVideo === false) await changeVideoChannelShare(videoInstanceUpdated, oldVideoChannel, t)
      }

      const isNewVideo = wasPrivateVideo && videoInstanceUpdated.privacy !== VideoPrivacy.PRIVATE
      await federateVideoIfNeeded(videoInstanceUpdated, isNewVideo)
    })

    logger.info('Video with name %s and uuid %s updated.', videoInstance.name, videoInstance.uuid)
  } catch (err) {
    // Force fields we want to update
    // If the transaction is retried, sequelize will think the object has not changed
    // So it will skip the SQL request, even if the last one was ROLLBACKed!
    resetSequelizeInstance(videoInstance, videoFieldsSave)

    throw err
  }
}

function getVideo (req: express.Request, res: express.Response) {
  const videoInstance = res.locals.video

  return res.json(videoInstance.toFormattedDetailsJSON())
}

async function viewVideo (req: express.Request, res: express.Response) {
  const videoInstance = res.locals.video

  const ip = req.ip
  const exists = await Redis.Instance.isViewExists(ip, videoInstance.uuid)
  if (exists) {
    logger.debug('View for ip %s and video %s already exists.', ip, videoInstance.uuid)
    return res.status(204).end()
  }

  await videoInstance.increment('views')
  await Redis.Instance.setView(ip, videoInstance.uuid)

  const serverAccount = await getServerActor()

  await sendCreateView(serverAccount, videoInstance, undefined)

  return res.status(204).end()
}

async function getVideoDescription (req: express.Request, res: express.Response) {
  const videoInstance = res.locals.video
  let description = ''

  if (videoInstance.isOwned()) {
    description = videoInstance.description
  } else {
    description = await fetchRemoteVideoDescription(videoInstance)
  }

  return res.json({ description })
}

async function listVideos (req: express.Request, res: express.Response, next: express.NextFunction) {
  const resultList = await VideoModel.listForApi({
    start: req.query.start,
    count: req.query.count,
    sort: req.query.sort,
    hideNSFW: isNSFWHidden(res),
    filter: req.query.filter as VideoFilter,
    withFiles: false
  })

  return res.json(getFormattedObjects(resultList.data, resultList.total))
}

async function removeVideoRetryWrapper (req: express.Request, res: express.Response, next: express.NextFunction) {
  const options = {
    arguments: [ req, res ],
    errorMessage: 'Cannot remove the video with many retries.'
  }

  await retryTransactionWrapper(removeVideo, options)

  return res.type('json').status(204).end()
}

async function removeVideo (req: express.Request, res: express.Response) {
  const videoInstance: VideoModel = res.locals.video

  await sequelizeTypescript.transaction(async t => {
    await videoInstance.destroy({ transaction: t })
  })

  logger.info('Video with name %s and uuid %s deleted.', videoInstance.name, videoInstance.uuid)
}

async function searchVideos (req: express.Request, res: express.Response, next: express.NextFunction) {
  const resultList = await VideoModel.searchAndPopulateAccountAndServer(
    req.query.search as string,
    req.query.start as number,
    req.query.count as number,
    req.query.sort as VideoSortField,
    isNSFWHidden(res)
  )

  return res.json(getFormattedObjects(resultList.data, resultList.total))
}
